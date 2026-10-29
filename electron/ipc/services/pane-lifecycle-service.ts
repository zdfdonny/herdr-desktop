/**
 * Pane 生命周期服务（R4）。
 *
 * 从 `IpcRouter` 抽出整个 pane 生命周期簇：两阶段创建、挂载、重启、恢复、
 * 关闭、聚焦。这是 router 里最大的一块，也是唯一持有「启动中间态」的地方。
 *
 * ## 两阶段创建（本服务存在的核心原因）
 *
 * 渲染侧要先挂载终端、量出精确 cols/rows，再把尺寸报给主进程。
 * 若直接 spawn 再 resize，TUI 会按错误尺寸画出首屏再被打断 ——
 * opencode 的整个界面会画到可视区之外。所以：
 * 1. `spawn` 只建 pane 条目，把参数存进 `pendingSpawns`；
 * 2. 渲染端量好尺寸后发 `pty:resize`，此时进程还没起，尺寸存进 `pendingSizes`；
 * 3. `attach` 读取暂存的参数与尺寸，一次性按正确尺寸拉起 PTY。
 *
 * ## 状态归属
 *
 * - `pendingSpawns` / `pendingSizes`：两阶段中间态，本服务独占；
 * - `reviving`（`RevivingPanes`）：与 web 簇共用，由 router 持有并注入 ——
 *   「重启失败保留 pane、新建失败回滚删除」这条分界线对两类 pane 都成立。
 */

import type { Session } from '../../runtime/session';
import type { PtyManager } from '../../runtime/pty-manager';
import type { WebAgentManager } from '../../runtime/web-agent-manager';
import type { SettingsStore } from '../../runtime/settings';
import type { ReportServer } from '../../runtime/report-server';
import type { AddProjectParams, PaneState, SpawnAgentParams } from '../../../shared/state';
import { agentById } from '../../../shared/agents/registry';
import { parseAgentLabel } from '../../../shared/detect/facade';
import { resolveLaunchEnv } from '../../platform';
import * as agentResume from '../../runtime/agent-resume';
import { IPC } from '../channels';
import type { MainToRendererMessage } from '../../../shared/protocol';
import type { RevivingPanes } from './reviving-panes';
import type { PaneErrorSink } from './pane-errors';

/** 本服务需要宿主提供的能力（窄接口）。 */
export interface PaneLifecycleHost extends PaneErrorSink {
  /** 推送完整会话快照给渲染端。 */
  pushSnapshot(): void;
  /** 广播一条消息给所有窗口。 */
  broadcast(message: MainToRendererMessage): void;
  /** 记录 / 解除 dsh 会话绑定。 */
  bindDshSession(paneId: string, sessionId: string | null): void;
  /** 尝试恢复 web 型 pane（委托给 WebAgentService）。 */
  tryReviveWeb(paneId: string, force?: boolean): boolean;
  /** 通知插件移除 web pane 的广播条目（委托给 WebAgentService）。 */
  unregisterWorkspace(port: number, cwd: string, paneId: string): void;
}

export class PaneLifecycleService {
  /** 已建 pane、尚未拉起进程的 spawn 参数。 */
  private readonly pendingSpawns = new Map<string, SpawnAgentParams>();
  /** 已建 pane、尚未拉起进程时终端上报的尺寸。 */
  private readonly pendingSizes = new Map<string, { cols: number; rows: number }>();

  constructor(
    private readonly session: Session,
    private readonly pty: PtyManager,
    private readonly web: WebAgentManager,
    private readonly settings: SettingsStore,
    private readonly reportServer: ReportServer,
    private readonly reviving: RevivingPanes,
    private readonly host: PaneLifecycleHost,
  ) {}

  /** 该 pane 是否处于「已建条目、未起进程」状态。 */
  hasPendingSpawn(paneId: string): boolean {
    return this.pendingSpawns.has(paneId);
  }

  /** 暂存尺寸：进程未起时由 `pty:resize` 走到这里。 */
  stashPendingSize(paneId: string, cols: number, rows: number): void {
    this.pendingSizes.set(paneId, { cols, rows });
  }

  // ---------------------------------------------------------------- 项目

  addProject(params: AddProjectParams): void {
    if (!params.path) return;
    this.session.addProject(params);
    this.host.pushSnapshot();
  }

  removeProject(projectId: string): void {
    const paneIds = this.session.removeProject(projectId);
    for (const paneId of paneIds) {
      this.pty.kill(paneId);
      this.web.release(paneId);
    }
    this.host.pushSnapshot();
  }

  // ------------------------------------------------------ 两阶段创建

  /** 第一阶段：创建 pane 条目，但**不**启动进程。 */
  spawn(params: SpawnAgentParams): void {
    if (!params.projectId) {
      this.host.pushError('error.noProject', undefined, { messageKey: 'error.noProjectDetail' });
      return;
    }

    let pane: ReturnType<Session['createAgent']>;
    try {
      pane = this.session.createAgent(params);
    } catch {
      this.host.pushError('error.projectNotFound', { id: params.projectId }, {
        messageKey: 'error.projectNotFoundDetail',
      });
      return;
    }

    /*
     * codex `resume <id>` 启动形态：从参数反推会话引用并持久化，
     * 之后即使进程死掉，重启该 pane 也能带着 `codex resume <id>` 恢复。
     * （对应 herdr 的 persisted_session_from_launch_args。）
     */
    const commandName = params.command.trim().split(/\s+/)[0];
    const inferred = agentResume.persistedSessionFromLaunchArgs(commandName, params.args ?? []);
    if (inferred) {
      this.session.setPaneAgentSession(pane.paneId, {
        source: inferred.source,
        agent: inferred.agent,
        kind: inferred.sessionRef.kind,
        value: inferred.sessionRef.value,
      });
    }

    this.pendingSpawns.set(pane.paneId, params);
    this.host.pushSnapshot();
  }

  /** 第二阶段：终端已就绪，用精确尺寸启动 PTY。 */
  attach(paneId: string): void {
    const params = this.pendingSpawns.get(paneId);
    if (!params) return;
    this.pendingSpawns.delete(paneId);

    const pane = this.session.getPane(paneId);
    if (!pane) return;

    // 用终端上报的精确尺寸启动；没有则回退到默认值
    const size = this.pendingSizes.get(paneId);
    this.pendingSizes.delete(paneId);

    const env = this.launchEnvFor(params.agentId ?? null);
    this.injectHookEnv(env, paneId, params.command);
    const result = this.pty.spawn(paneId, params, env, pane.cwd ?? undefined, size);

    if (!result.ok) {
      /*
       * spawn 失败的回滚策略：
       * - 新建的 pane：回滚删除；
       * - 重启恢复的 pane：**保留**条目并回到停止态 ——
       *   命令被卸载等原因导致的一次失败不应连带丢掉用户的会话结构。
       */
      if (this.reviving.has(paneId)) {
        this.reviving.delete(paneId);
        this.session.setPaneRunning(paneId, false);
      } else {
        this.session.closePane(paneId);
      }
      this.host.pushError(
        result.reason === 'not-found' ? 'error.commandNotFound' : 'error.spawnFailed',
        { command: params.command, reason: result.error },
        { paneId, projectId: params.projectId },
      );
      this.host.pushSnapshot();
      return;
    }

    this.reviving.delete(paneId);

    /*
     * 进程检测等价物（对应 herdr 的 set_detected_agent_process_at）：
     * desktop 没有独立的进程名检测，这里先用**创建时声明的身份**，
     * 缺失时才回退到「启动命令首 token」。
     *
     * 声明的身份优先很重要：TUI 不一定打印品牌名（opencode / antigravity 尤其
     * 不可靠），而 full-lifecycle hook 权威（如 opencode）必须在这一步就生效，
     * 否则它的 hook 上报会因为 detectedAgent 为空而被全部丢弃。
     */
    const terminal = this.session.getTerminal(paneId);
    if (terminal) {
      const declared = agentById(params.agentId);
      const commandName = params.command.trim().split(/\s+/)[0];
      const detectedAgent = declared?.id ?? parseAgentLabel(commandName);
      if (detectedAgent) {
        terminal.setDetectedAgentProcessAt(detectedAgent, Date.now());
      }
    }

    /*
     * 工作目录失效时 pane 仍会启动（回退到主目录），但用户需要知道
     * 「agent 不在我以为的那个目录里」—— 否则会在错误的目录里改文件。
     * 不当作错误处理：agent 已经正常跑起来了。
     */
    if (result.cwdFallback) {
      this.host.pushError(
        'error.cwdNotFound',
        { path: result.cwdFallback.requested, used: result.cwdFallback.used },
        { paneId, projectId: params.projectId },
      );
    }

    this.host.pushSnapshot();
  }

  // ------------------------------------------------------------ 重启

  /**
   * 重启一个 pane（侧栏「重新启动」按钮入口）。
   *
   * 复用两阶段创建机制：把参数放回 pendingSpawns 并标记 running，
   * 渲染端随后挂载终端 → fit → 上报尺寸 → attach，首帧排版即正确。
   */
  respawn(paneId: string, force: boolean): void {
    const pane = this.session.getPane(paneId);
    if (!pane) return;

    /*
     * 恢复参数必须在 killForRestart 之前算出来。
     *
     * killForRestart 会调 clearAgentRuntimeIdentityAfterRespawn()，把 hookAuthority
     * 与 persistedAgentSession 一起清掉，而 resumeParamsFor 正是从 TerminalState 读
     * 会话引用（currentSessionForPersistence）。清完再算只能拿到 null，重启就退化成
     * 「重放原始 command/args」，表现为重启后没有恢复会话。
     */
    const resume = force ? this.resumeParamsFor(pane) : undefined;

    if (force) {
      this.killForRestart(paneId, pane.kind === 'web');
      /*
       * 不在这里 setPaneRunning(false) 再走 revive 的普通分支：
       * 那会推出一个「停止态」的中间快照，侧栏的 ▶ 图标和终端区域
       * 会闪一下才恢复。下面直接按运行态重启，快照只推最终状态。
       */
    }

    const revived =
      pane.kind === 'web'
        ? this.host.tryReviveWeb(paneId, force)
        : this.tryRevive(paneId, force, resume);
    if (revived) {
      /*
       * 顺序要紧：先让 tryRevive 把参数写进 pendingSpawns，再递增 restartSeq。
       * 渲染端收到递增后的快照会重建终端，随后的 attach 才能取到参数；
       * 反过来推的话，重建发生在参数入队之前，attach 会空手而归。
       */
      if (force) {
        this.session.bumpPaneRestart(paneId);
      }
      this.host.pushSnapshot();
    }
  }

  /**
   * 杀掉 pane 的现有进程，为「运行中重启」做准备。
   *
   * 只做 kill，不碰 session 状态 —— 由调用方紧接着走 revive 路径重新拉起。
   * 必须先 kill 再 revive：tryRevive 会检查 `pty.has()` / `web.has()`，
   * 残留的运行时会让它判定「已在运行」而直接返回。
   *
   * web pane 是例外：共享进程只有一个，结束它就等于把**所有** web pane 的服务端
   * 一起重启（其余 pane 正在跑的会话会一并丢失），因此这里只解除该 pane 的引用、
   * 不动进程。
   */
  killForRestart(paneId: string, isWeb: boolean): void {
    if (isWeb) {
      this.web.release(paneId);
    } else {
      this.pty.kill(paneId);
      /*
       * kill() 会先置 disposed，导致 PtyManager 的 onExit 回调被吞掉，
       * 渲染端收不到 pty:exit、回放缓冲不会被清。这里补一条不带退出语义的
       * 通知，让渲染端丢弃旧缓冲。
       *
       * 不清的后果：重启后终端重建会把旧会话输出（含 CSI c / DECRPM /
       * OSC 11;? 等终端能力查询）重放进新 xterm，新实例逐条作答，应答写进
       * 刚创建、子进程尚未切 raw 模式（ICANON|ECHO|ECHOCTL）的 PTY，
       * 被行规程原样回显成 `^[[?1;2c...` 乱码。
       */
      this.host.broadcast({ type: IPC.PTY_RESET, payload: { paneId } });
    }
    // 两阶段创建的中间态一并清掉，避免旧参数被 attach 复用
    this.pendingSpawns.delete(paneId);
    this.pendingSizes.delete(paneId);
    this.reviving.delete(paneId);
    // 运行中强制重启：重置 agent 运行时身份（对应 herdr clear_agent_runtime_identity_after_respawn）
    this.session.getTerminal(paneId)?.clearAgentRuntimeIdentityAfterRespawn();
  }

  /**
   * 尝试恢复一个停止态 pane（只改状态，不推送快照）。
   *
   * 返回是否触发了恢复；调用方决定何时推送快照。
   * `resume` 是调用方预先算好的恢复参数：`undefined` 表示「这里现算」，
   * `null` 表示「已算过、没有可用计划」。
   */
  tryRevive(paneId: string, force = false, resume?: SpawnAgentParams | null): boolean {
    const pane = this.session.getPane(paneId);
    if (!pane?.command) return false;
    if (!force && (pane.running || this.pty.has(paneId) || this.pendingSpawns.has(paneId))) {
      return false;
    }

    const resumeParams = resume !== undefined ? resume : this.resumeParamsFor(pane);
    const params = resumeParams ?? {
      projectId: pane.projectId,
      command: pane.command,
      args: pane.args ?? [],
      cwd: pane.cwd ?? undefined,
      label: pane.label ?? undefined,
    };
    this.pendingSpawns.set(paneId, params);
    this.reviving.add(paneId);
    this.session.setPaneRunning(paneId, true);
    return true;
  }

  /**
   * 从 pane 的持久化 agent 会话引用生成恢复参数。
   *
   * 对应 herdr 的 restore_plan_for_snapshot：有官方来源的会话引用且恢复
   * 开关打开时，用该 agent 的恢复命令（如 `claude --resume <id>`）替换原始
   * 启动命令；否则返回 null，走原来的「重放 command/args」路径。
   */
  resumeParamsFor(pane: PaneState): SpawnAgentParams | null {
    if (!agentResume.RESUME_AGENTS_ON_RESTORE) return null;
    // 会话引用由 TerminalState 仲裁后投影（不再直接读 pane.agentSession）
    const current = this.session.getTerminal(pane.paneId)?.currentSessionForPersistence() ?? null;
    if (!current || !pane.command) return null;

    // 命令首 token 是真实可执行文件，cursor 等平台差异由 pty-manager 处理。
    const executable = pane.command.trim().split(/\s+/)[0];
    const plan = agentResume.resumePlanForPane(executable, {
      source: current.source,
      agent: current.agent,
      kind: current.kind,
      value: current.value,
    });
    if (!plan) return null;

    return {
      projectId: pane.projectId,
      command: plan.argv[0],
      args: plan.argv.slice(1),
      cwd: pane.cwd ?? undefined,
      label: pane.label ?? undefined,
    };
  }

  // -------------------------------------------------------- 环境变量

  /**
   * 组装启动 agent 子进程的环境变量。
   *
   * 在平台基础环境之上，按设置注入代理：代理地址已配置且该**智能体**在
   * proxyAgents 中被开启时，注入 HTTP_PROXY / HTTPS_PROXY（大小写各一份）与
   * ALL_PROXY，并把本地回环地址排除在代理之外。注入发生在进程启动时 ——
   * 运行中的 agent 不受后续设置变更影响，需要生效时重启该 agent。
   */
  launchEnvFor(agentId: string | null): Record<string, string> {
    const env = resolveLaunchEnv().env;
    const settings = this.settings.get();
    const proxyUrl = settings.proxyUrl.trim();
    /*
     * 用 agentId 而不是启动命令作键：命令含平台分支（cursor 在 Windows 上是
     * `cursor-agent.cmd`、macOS 上是 `cursor-agent`），用命令会让同一智能体在
     * 两个平台互不承认，且改命令会静默丢掉用户开关（见附录 D #19）。
     */
    if (!proxyUrl || !agentId || settings.proxyAgents[agentId] !== true) {
      return env;
    }
    const noProxy = 'localhost,127.0.0.1,::1';
    return {
      ...env,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      ALL_PROXY: proxyUrl,
      all_proxy: proxyUrl,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    };
  }

  /**
   * 注入 hook 上报所需的环境变量（对应 herdr 的 apply_pane_base_env）。
   *
   * 官方集成 hook 脚本据此知道自己的 pane、agent 和上报地址。
   */
  injectHookEnv(env: Record<string, string>, paneId: string, command: string): void {
    const reportUrl = this.reportServer.reportUrl;
    if (!reportUrl) return;
    env.HERDR_DESKTOP_PANE_ID = paneId;
    env.HERDR_DESKTOP_AGENT = command.trim().split(/\s+/)[0];
    env.HERDR_DESKTOP_REPORT_URL = reportUrl;
  }

  // ------------------------------------------------------ 关闭与聚焦

  close(paneId: string): void {
    // 关闭 web pane 时，通知插件把这个 paneId 从广播表里移除，避免映射无界增长。
    const closing = this.session.getPane(paneId);
    if (closing?.kind === 'web' && closing.cwd && closing.port) {
      this.host.unregisterWorkspace(closing.port, closing.cwd, paneId);
    }
    // 清理该 pane 的会话绑定。
    this.host.bindDshSession(paneId, null);
    this.pty.kill(paneId);
    this.web.release(paneId);
    // 清理两阶段创建的中间态，避免 pending 泄漏
    this.pendingSpawns.delete(paneId);
    this.pendingSizes.delete(paneId);
    this.reviving.delete(paneId);
    this.session.closePane(paneId);
    this.reviveFocusedIfStopped();
    this.host.pushSnapshot();
  }

  focus(paneId: string): void {
    // 聚焦即「已看」：Session.focusPane 会置 seen=true，done 投影自动回落 idle。
    this.session.focusPane(paneId);
    /*
     * 选中即恢复：聚焦的 pane 处于停止态时自动拉起进程。
     *
     * 必须与 focusPane 合并在**同一次**快照里推送 —— 若分两次推，
     * 渲染端会先收到「已聚焦但未运行」的中间态，
     * 「重新启动」提示会闪现一帧才被终端替换。
     */
    const pane = this.session.getPane(paneId);
    if (pane?.kind === 'web') {
      this.host.tryReviveWeb(paneId);
    } else {
      this.tryRevive(paneId);
    }
    this.host.pushSnapshot();
  }

  /**
   * 关闭/退出一个 pane 后，若焦点被转移到停止态 pane，把它也拉起。
   *
   * 场景：终端里 Ctrl+C 退出聚焦的 agent → onExit → session.closePane 把焦点
   * 转移到同项目第一个 pane（可能是恢复出的停止态）。渲染层不参与这条路径，
   * 不会像侧栏关闭那样先恢复幸存者，因此这里补一次。
   */
  reviveFocusedIfStopped(): void {
    const focusedPaneId = this.session.snapshot().focusedPaneId;
    if (!focusedPaneId) return;
    const pane = this.session.getPane(focusedPaneId);
    if (!pane) return;
    if (pane.kind === 'web') {
      this.host.tryReviveWeb(focusedPaneId);
    } else {
      this.tryRevive(focusedPaneId);
    }
  }
}
