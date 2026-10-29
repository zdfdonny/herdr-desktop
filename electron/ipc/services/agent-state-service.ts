/**
 * 智能体状态上报与仲裁服务（R6）。
 *
 * 从 `IpcRouter` 抽出整个「状态从哪来、算成什么、要不要响」的链路。它有两类入口：
 *
 * - **主动观测**：PTY 有输出 → `refresh` 跑一次屏幕检测（5 步处理链）；
 * - **被动上报**：官方集成 hook 经 HTTP 报回状态 / 会话引用 → `reportSession`。
 *
 * 两条入口最终都汇聚到状态机（`TerminalState`）与会话投影（`Session`），
 * 再经通知调度决定要不要提醒用户。把它们放在一起是因为「完成提示音」这个
 * 用户可见行为横跨两条路径：屏幕判出的完成可能被 hook 权威压掉，
 * 而 hook 迟到的心跳又可能把已完成的 pane 顶回去 —— 分开看任何一半都会误判。
 */

import type { Session } from '../../runtime/session';
import type { PtyManager } from '../../runtime/pty-manager';
import type { TerminalState } from '../../runtime/terminal/terminal-state';
import type { TerminalStateMutation } from '../../runtime/terminal/state/terminal-types';
import type { SessionReport } from '../../runtime/report-server';
import type { AgentSessionRef } from '../../runtime/terminal/state/agent-session-ref';
import type { DetectedState } from '../../../shared/state';
import { agentById } from '../../../shared/agents/registry';
import { agentSource, type AgentId } from '../../../shared/agents/agent-id';
import { isCompletionTransition } from '../../../shared/agents/status';
import { detectFromSnapshot } from '../../runtime/agent-detector';
import type { DetectionResult } from '../../runtime/agent-detector';
import * as agentResume from '../../runtime/agent-resume';
import { hookStatuses } from '../../integration';
import { HOOK_WORKING_TTL_MS } from '../../runtime/terminal/terminal-state';
import type { NotificationScheduler } from '../notification-scheduler';
import type { DshSessionBinding } from './dsh-session-binding';
import { screenReportsCompletion, shouldNotifyOnScreenTransition } from './state-arbiter';
import type { PaneErrorSink } from './pane-errors';

/** 本服务需要宿主提供的能力（窄接口）。 */
/**
 * 一条 agent 上报（paneId 由调用方单独传入）。
 *
 * 与 SessionReport 同构但去掉 paneId：上报方的 HTTP 报文里带 paneId，
 * 而内部路由时 paneId 与 report 是分开传递的（见 
eportSession）。
 */
export type AgentReport = Omit<SessionReport, 'paneId'>;

export interface AgentStateHost extends PaneErrorSink {
  /** 推送完整会话快照给渲染端。 */
  pushSnapshot(): void;
}

export class AgentStateService {
  /** 「该 agent 的完成判定是否交给集成 hook」的缓存（agent → bool）。 */
  private readonly hookCompletionCache = new Map<string, boolean>();

  /** 「hook 的 working 上报到期」定时器（paneId → timer）。 */
  private readonly hookWorkingExpiry = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly session: Session,
    private readonly pty: PtyManager,
    private readonly notifications: NotificationScheduler,
    private readonly dshBinding: DshSessionBinding,
    private readonly host: AgentStateHost,
  ) {}

  /**
   * 释放资源（应用退出时调用）。
   *
   * 「working 过期重评估」用 setTimeout 挂着；虽然每个都 unref 了（不会阻塞进程退出），
   * 但退出时若恰好触发，会去读已经拆掉的 PTY 与状态机。显式清掉更干净。
   */
  dispose(): void {
    for (const timer of this.hookWorkingExpiry.values()) clearTimeout(timer);
    this.hookWorkingExpiry.clear();
    this.hookCompletionCache.clear();
  }
  /** 清空「完成归属」缓存（安装/卸载集成后调用）。 */
  clearCompletionCache(): void {
    this.hookCompletionCache.clear();
  }

  // ------------------------------------------------------ hook 上报入口

  /** 处理一条官方集成上报（状态 + 会话引用）。 */
  reportSession(paneId: string, report: AgentReport): void {
    const source = report.source;
    const ref = agentResume.sessionRefFromReport(
      source,
      report.agent,
      report.sessionId ?? null,
      report.sessionPath ?? null,
    );

    for (const targetPaneId of this.reportTargets(paneId, report)) {
      const terminal = this.session.getTerminal(targetPaneId);
      if (!terminal) continue;
      /*
       * `done` 不是检测层状态（它只由投影层派生），所以带 done 的上报按「仅会话」处理；
       * 其余状态走状态分支。
       */
      if (report.state && report.state !== 'done') {
        this.applyStateReport(targetPaneId, terminal, { ...report, state: report.state }, source, ref);
      } else if (ref) {
        this.applySessionReport(terminal, report, source, ref);
      }
    }

    this.host.pushSnapshot();
  }

  /**
   * 这条上报该落到哪些 pane 上。
   *
   * 一般是报文自带的 paneId；但 web 型智能体的同一个会话可以被多个 pane 同时查看，
   * 所以要按 sessionId 反查绑定，精确路由到所有正在看该会话的 pane。
   * 只对声明了 `routeBySessionId` 的智能体做反查，避免其它智能体的 sessionId
   * 恰好碰撞时被误路由。
   */
  private reportTargets(paneId: string, report: AgentReport): string[] {
    const routed = agentById(report.agent)?.policy.routeBySessionId === true;
    if (!routed || !report.sessionId) return [paneId];
    const bound = this.dshBinding.panesFor(report.sessionId);
    return bound.length > 0 ? bound : [paneId];
  }

  /**
   * 处理一条**状态**上报。
   *
   * 三道边界丢弃（顺序不可调换）：
   * 1. 屏幕上正显示权限/信任对话框时丢弃 working；
   * 2. 迟到的心跳不得把已完成的 pane 拉回 working；
   * 3. seq 缺失/非法时补一个严格递增的值。
   */
  private applyStateReport(
    paneId: string,
    terminal: TerminalState,
    report: AgentReport & { state: DetectedState },
    source: string,
    ref: AgentSessionRef | null,
  ): void {
    const state = report.state;

    /*
     * 边界丢弃 1：屏幕上正显示权限/信任对话框时，丢弃 hook 报来的 working。
     *
     * 一条比 blocker 更新的 working 会把 blocked 顶掉，屏幕下一次刷新再判回 blocked ——
     * 一次权限提示被拆成成串跳变，通知又被冷却吃掉一半，表现为「阻塞一次响一次不响」。
     * 只丢 working：blocked / idle 必须照常放行（idle 是完成信号）。
     */
    if (state === 'working' && terminal.screenVisibleBlocker()) return;

    /*
     * 边界丢弃 2：工具完成心跳走 async，Stop 是同步的。
     * 本轮末尾只回一两句话时 idle 会先落地，随后迟到的心跳以更大 seq 把状态顶回
     * working —— 完成通知在投递前复核时被判「证据不成立」而丢掉（提示音丢失），
     * TTL 过期后又投影一次 done（重复徽标）。
     */
    if (terminal.isStaleHeartbeat(state, report.heartbeat)) return;

    /*
     * 边界 3：seq 兜底。
     *
     * hook 脚本未必能给出可移植的单调序号（macOS 的 BSD date 不支持 %3N，旧脚本会恒发 0）；
     * 状态机要求 seq 严格递增，恒发 0 会让 Stop 的 idle 全被丢掉 —— 表现为完成时没有提示音。
     */
    const reportedSeq = typeof report.seq === 'number' && report.seq > 0 ? report.seq : null;
    const seq = reportedSeq ?? terminal.nextHookReportSeq();
    const mutation = terminal.setHookAuthorityAt(
      source,
      report.agent,
      state,
      report.message ?? null,
      ref,
      seq,
      Date.now(),
    );
    if (!mutation) return;

    // 手动停止（aborted）：抑制完成 —— 不投影 done、不记录完成、不响完成声音。
    const aborted = report.completion === 'aborted';
    const transition = this.session.applyStateChange(paneId, mutation, aborted);
    // 重放与手动停止都只刷新状态，不触发声音/toast。
    if (!report.replay && !aborted) {
      this.notifyForTransition(paneId, mutation, transition, report.message ?? undefined);
    }
    // working 上报会过期（见 scheduleHookWorkingExpiry），需要有人在到期时重新评估
    if (state === 'working') {
      this.scheduleHookWorkingExpiry(paneId);
    } else {
      this.cancelHookWorkingExpiry(paneId);
    }
  }

  /**
   * 处理一条**仅会话身份**的上报。
   *
   * 刻意**不**补 seq（与状态上报不同）：opencode 的 select 靠 `seq === null` 走
   * 「未排序选择」那条专门分支，补了 seq 就会破坏它的重绑语义。
   */
  private applySessionReport(
    terminal: TerminalState,
    report: AgentReport,
    source: string,
    ref: AgentSessionRef,
  ): void {
    terminal.setAgentSessionRefForSessionStart(
      source,
      report.agent,
      ref,
      report.seq ?? null,
      report.sessionStartSource ?? null,
      Date.now(),
    );
  }

  // ------------------------------------------------- dsh 会话绑定

  /**
   * 记录 dsh web pane 当前正在查看的会话（由渲染端 WebPane 轮询上报）。
   * 一个 pane 只绑定一个会话；一个会话可被多个 pane 同时查看。
   */
  bindDshSession(paneId: string, sessionId: string | null): void {
    // 绑定表本身在 DshSessionBinding 里（含「换绑后需要重放」的判定）。
    if (this.dshBinding.bind(paneId, sessionId) && sessionId) {
      this.requestDshSessionReplay(paneId, sessionId);
    }
  }

  /** 请求 dsh 插件立即重发某个会话的当前状态（best-effort）。 */
  private requestDshSessionReplay(paneId: string, sessionId: string): void {
    const pane = this.session.getPane(paneId);
    if (!pane || pane.kind !== 'web' || !pane.port) return;
    // 带上 paneId：插件 replay 时若该 pane 尚未注册进广播表，也能临时补注册。
    void fetch(`http://127.0.0.1:${pane.port}/herdr-desktop/register-workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'replay', sessionId, paneId }),
    }).catch(() => {
      // 插件旧版本无 replay 模式时忽略。
    });
  }

  // ------------------------------------------------------ 主动观测入口

  /**
   * 刷新某个 pane 的智能体状态 —— **一次屏幕观测的完整处理链**。
   *
   * 由 5 个单一职责的步骤组成（拆开是为了每步都能单独读/单独测）。
   * 步骤之间的短路条件（skipStateUpdate）由本方法显式表达，
   * 不藏在各步骤内部 —— 否则「为什么这次没有更新状态」就又要靠通读全文才知道。
   */
  refresh(paneId: string): void {
    const terminal = this.session.getTerminal(paneId);
    if (!terminal) return;

    /*
     * web pane 直接短路（附录 D #11）。
     *
     * web pane 没有 PTY，`pty.snapshot()` 返回空串，但 `detectFromSnapshot('')`
     * 依然会产出一个结果 —— 一旦走到下面就会把 TerminalState 的 `screenObserved`
     * 置为 true，而该标志的语义是「这个 pane 有真实屏幕可观测」。它被用来决定
     * hook working 的 TTL 是否生效：web pane 本不该受 TTL 约束，误置后
     * 一次 working 会因 TTL 到期被错误降级为 idle。
     *
     * 根因是「用是否观测过反推是否为 web」不可靠；这里按 pane.kind 判，
     * 让标志只在真正有终端输出的 pane 上置位。
     */
    if (this.session.getPane(paneId)?.kind === 'web') return;

    const observation = this.observe(paneId);
    // 展示字段先更新：skipStateUpdate 的规则只否决「状态」，不影响侧栏标题。
    this.session.updateAgentPresentation(paneId, observation.name, observation.title);

    /*
     * skip_state_update：命中的规则明确要求「不要拿这次观测改状态」。
     * 典型场景：claude 打开 /model 选择器或详细记录视图时，屏幕上不再有
     * spinner/prompt box 特征，若照常按 fallback 判成 idle，
     * 就会产生一次 working → idle 的假完成跳变（误响提示音）。
     */
    if (observation.skipStateUpdate) {
      this.host.pushSnapshot();
      return;
    }

    const arbitration = this.arbitrate(paneId, terminal, observation);
    this.notifyIfNeeded(paneId, arbitration);
    this.captureSessionId(paneId, observation);

    this.host.pushSnapshot();
  }

  /**
   * 屏幕快照 → 检测结果。
   *
   * agent 名检测不到时回退到启动命令首 token（opencode 的 TUI 底部不出现名字）。
   */
  private observe(paneId: string): DetectionResult {
    const snapshot = this.pty.snapshot(paneId);
    const pane = this.session.getPane(paneId);
    const fallbackAgent = pane?.command?.trim().split(/\s+/)[0] ?? null;
    return detectFromSnapshot(snapshot, fallbackAgent);
  }

  /**
   * 状态仲裁：把屏幕信号交给状态机，并决定「完成」归谁判。
   *
   * agent 参数用 `terminal.detectedAgent`（进程检测等价物），屏幕只提供 fallback 状态；
   * 不能用 `result.detectedName` —— 那会因 TUI 不打印 agent 名而把 detectedAgent 清空。
   */
  private arbitrate(
    paneId: string,
    terminal: TerminalState,
    result: DetectionResult,
  ): {
    mutation: TerminalStateMutation;
    transition: { from: string; to: string } | null;
    hooksOwnCompletion: boolean;
  } {
    const mutation = terminal.setDetectedStateWithScreenSignalsAt(
      terminal.detectedAgent,
      result.status,
      result.visibleBlocker,
      result.visibleIdle,
      result.visibleWorking,
      false,
      Date.now(),
    );
    /*
     * 完成判定交给 hook 的智能体（`policy.screenOwnsCompletion === false`）：
     * 屏幕观测不产生「完成」—— 既不发通知，也不在投影层置 done / 写 completionSeq。
     *
     * 只掐掉通知（历史实现）会留下另一半后果：pane 依然被记成「未看完成」，后台 pane
     * 的侧栏圆点变成绿色 done，要等用户聚焦回来才回落 idle。所以这里把同一条判据也传给
     * applyStateChange（forceSuppressCompletion），让投影层连 seen / completionSeq 一起不更新。
     */
    const hooksOwnCompletion =
      this.agentCompletionFromHooks(paneId) || terminal.hookStateAuthorityActive();
    const screenCompletion = screenReportsCompletion(mutation.effectiveStateChange);
    const transition = this.session.applyStateChange(
      paneId,
      mutation,
      screenCompletion && hooksOwnCompletion,
    );
    return { mutation, transition, hooksOwnCompletion };
  }

  /** 按状态跳变决定是否发通知（完成归属 hook 时跳过屏幕判出的「完成」）。 */
  private notifyIfNeeded(
    paneId: string,
    arbitration: {
      mutation: TerminalStateMutation;
      transition: { from: string; to: string } | null;
      hooksOwnCompletion: boolean;
    },
  ): void {
    const { transition, hooksOwnCompletion, mutation } = arbitration;
    if (shouldNotifyOnScreenTransition(transition, hooksOwnCompletion)) {
      this.notifyForTransition(paneId, mutation, transition);
    }
  }

  /**
   * 采集端兜底：从终端输出识别出会话 id 时持久化它，之后重启该 pane 就能
   * 带 `--resume` / `--session` 恢复。
   *
   * 权威来源仍是 hook 上报；这里只做兜底，且经 `sessionRefFromReport` 校验官方来源。
   */
  private captureSessionId(paneId: string, result: DetectionResult): void {
    if (!result.detectedName || !result.sessionId) return;
    const source = agentSource(result.detectedName as AgentId);
    const ref = agentResume.sessionRefFromReport(source, result.detectedName, result.sessionId, null);
    if (!ref) return;
    this.session.setPaneAgentSession(paneId, {
      source,
      agent: result.detectedName,
      kind: ref.kind,
      value: ref.value,
    });
  }

  // ---------------------------------------------------------- 通知

  /**
   * 根据状态跳变决定通知：
   * - blocked → 通知 blocked；
   * - 完成跳变 → 通知 done，**无论前台后台** —— 声音应始终提示，
   *   toast 由渲染端按「该 pane 是否前台」决定是否展示。
   */
  private notifyForTransition(
    paneId: string,
    mutation: TerminalStateMutation,
    transition: { from: string; to: string } | null,
    message?: string,
  ): void {
    if (!transition) return;
    if (transition.to === 'blocked') {
      this.notifications.enqueue(paneId, 'blocked', message);
      return;
    }
    const change = mutation.effectiveStateChange;
    const completed =
      change !== null && isCompletionTransition(change.previousState, change.state);
    if (completed || transition.to === 'done') {
      this.notifications.enqueue(paneId, 'done', message);
    }
  }

  /**
   * 安排一次「working 过期后重新评估」。
   *
   * 状态机只在有观测时才重算（PTY 数据 / hook 上报）。用户按 Esc 取消后 TUI 静止，
   * 不会再有观测，TTL 就永远不会被求值。这里在到期后主动跑一次屏幕检测。
   * 重复上报会重置定时器（每次 working 都刷新 TTL）。
   */
  private scheduleHookWorkingExpiry(paneId: string): void {
    /*
     * 只对真有 PTY 的 pane 安排：web pane 没有终端输出，refresh 会拿空快照
     * 去做屏幕检测，反而把 dsh 的状态改坏。
     */
    if (!this.pty.has(paneId)) return;
    this.cancelHookWorkingExpiry(paneId);
    const timer = setTimeout(() => {
      this.hookWorkingExpiry.delete(paneId);
      // 重新跑一次屏幕检测；此时 hook 的 working 已过期，状态会按屏幕判定
      this.refresh(paneId);
    }, HOOK_WORKING_TTL_MS + 100);
    timer.unref?.();
    this.hookWorkingExpiry.set(paneId, timer);
  }

  private cancelHookWorkingExpiry(paneId: string): void {
    const timer = this.hookWorkingExpiry.get(paneId);
    if (!timer) return;
    clearTimeout(timer);
    this.hookWorkingExpiry.delete(paneId);
  }

  /** 该智能体的「完成」是否由集成 hook 负责。 */
  private agentCompletionFromHooks(paneId: string): boolean {
    const agent = this.session.agentForPane(paneId);
    if (!agent || agent.policy.screenOwnsCompletion) return false;
    if (!agent.policy.completionRequiresIntegration) return true;
    const cached = this.hookCompletionCache.get(agent.id);
    if (cached !== undefined) return cached;
    // 注意只认 `installed`，不认 `outdated`：旧版本集成未必会上报状态。
    const installed = hookStatuses()[agent.id] === 'installed';
    this.hookCompletionCache.set(agent.id, installed);
    return installed;
  }
}
