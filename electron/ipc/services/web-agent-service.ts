/**
 * Web 型智能体的托管服务（R3）。
 *
 * 从 `IpcRouter` 抽出整个 web 簇：创建 pane、拉起共享进程、注册 workspace、
 * 崩溃收尾。它与 PTY 那条路径**结构相似但完全不同**：
 * - PTY 每个 pane 一个进程；web 是**全 app 共享一个进程**，多个 pane 是它里面的多个会话；
 * - 因此第二个及后续项目拿不到首次 spawn 的 env/cwd，必须通过插件回环路由补注册；
 * - 「是哪个智能体」由 pane 的声明身份决定（`session.agentForPane`），不写死 dsh。
 *
 * 依赖通过**窄 host 接口**注入：本服务不认识 `IpcRouter` 整体，
 * 只回调它需要的几个能力（推快照 / 推错误 / 广播 / 启动环境 / 关闭 pane）。
 */

import type { Session } from '../../runtime/session';
import type { WebAgentManager } from '../../runtime/web-agent-manager';
import { hostEnv } from '../../support/host-env';
import { IPC } from '../channels';
import type { MainToRendererMessage } from '../../../shared/protocol';
import type { SpawnWebAgentParams } from '../../../shared/state';
import type { RevivingPanes } from './reviving-panes';
import type { PaneErrorSink } from './pane-errors';

/** 本服务需要宿主提供的能力（窄接口）。 */
export interface WebAgentHost extends PaneErrorSink {
  /** 推送完整会话快照给渲染端。 */
  pushSnapshot(): void;
  /** 广播一条消息给所有窗口。 */
  broadcast(message: MainToRendererMessage): void;
  /** 按代理开关键构造环境变量（键是 agentId 或普通终端的预设 id，非启动命令）。 */
  launchEnvFor(proxyKey: string | null, paneId?: string): Record<string, string>;
  /** 注入 herdr-desktop 标记环境变量，让智能体侧插件认得出是本应用拉起的。 */
  injectHookEnv(env: Record<string, string>, paneId: string, command: string): void;
  /** 关闭 pane（共享进程崩溃时收尾用）。 */
  closePane(paneId: string): void;
}

export class WebAgentService {
  constructor(
    private readonly session: Session,
    private readonly web: WebAgentManager,
    private readonly reviving: RevivingPanes,
    private readonly host: WebAgentHost,
  ) {}

  /** 创建 web 型智能体的 pane（新建路径）。 */
  spawn(params: SpawnWebAgentParams): void {
    if (!params.projectId) {
      this.host.pushError('error.noProject', undefined, { messageKey: 'error.noProjectDetail' });
      return;
    }

    let pane: ReturnType<Session['createWebAgent']>;
    try {
      pane = this.session.createWebAgent(params, hostEnv());
    } catch {
      this.host.pushError('error.projectNotFound', { id: params.projectId }, {
        messageKey: 'error.projectNotFoundDetail',
      });
      return;
    }

    this.start(pane.paneId);
    this.host.pushSnapshot();
  }

  /**
   * 启动某个 web pane 托管的服务进程（新建与恢复共用）。
   *
   * 就绪前 pane 已标记 running、webUrl 为 null，渲染端显示「正在启动」；
   * 就绪后回填 webUrl 并推送 `web:ready`（带认证链接）。
   */
  start(paneId: string): void {
    const pane = this.session.getPane(paneId);
    if (!pane || pane.kind !== 'web') return;
    const agent = this.session.agentForPane(paneId);
    if (!agent) {
      this.host.pushError('error.commandNotFound', { command: pane.command ?? '' }, {
        paneId,
        projectId: pane.projectId,
      });
      return;
    }
    // 新建 vs 恢复/重启：新建需要新会话，恢复/重启需要恢复该 pane 上次的会话。
    const restore = this.reviving.has(paneId);

    // 代理开关以 agentId 为键（settings.proxyAgents），并带上 paneId 写诊断日志。
    const env = this.host.launchEnvFor(agent.id, paneId);
    this.host.injectHookEnv(env, paneId, agent.command(hostEnv()));
    // 显式带项目目录，插件用它注册工作区（不依赖 process.cwd()，防进程 chdir）。
    if (pane.cwd) env.HERDR_DESKTOP_CWD = pane.cwd;

    void this.web.acquire(paneId, env, pane.cwd ?? undefined).then(async (result) => {
      if (result.ok) {
        // pane 可能在共享进程启动期间被关闭：清理掉这次遗留的引用，
        // 避免它把共享进程的引用计数卡住、导致无法回收。
        if (!this.session.getPane(paneId)) {
          this.web.release(paneId);
          return;
        }
        this.reviving.delete(paneId);
        // 共享单进程只在首次 spawn 拿到 env/cwd，第二个及后续项目需要在运行时
        // 通过插件暴露的本地路由把 cwd 注册进去，否则工作目录会停留在首项目。
        const landingSessionId = await this.registerWorkspace(
          result.port,
          pane.cwd ?? null,
          paneId,
          restore ? 'restore' : 'create',
        );
        this.session.setPaneWebUrl(paneId, result.cleanUrl);
        // 记录共享进程端口（informational；端口由共享进程统一持有）。
        this.session.setPanePort(paneId, result.port);
        this.host.broadcast({
          type: IPC.WEB_READY,
          payload: { paneId, url: result.url, sessionId: landingSessionId },
        });
        this.host.pushSnapshot();
        return;
      }

      /*
       * spawn 失败的回滚策略（与 PTY 一致）：
       * - 新建的 pane：回滚删除；
       * - 重启恢复的 pane：保留条目并回到停止态。
       */
      if (this.reviving.has(paneId)) {
        this.reviving.delete(paneId);
        this.session.setPaneRunning(paneId, false);
      } else {
        this.session.closePane(paneId);
      }
      this.host.pushError(
        result.reason === 'not-found' ? 'error.commandNotFound' : 'error.spawnFailed',
        { command: 'dsh web', reason: result.error },
        { paneId, projectId: pane.projectId },
      );
      this.host.pushSnapshot();
    });
  }

  /**
   * 尝试恢复一个停止态的 web pane（只改状态，不推送快照）。
   *
   * 返回是否真的发起了恢复，便于调用方决定要不要补推快照。
   */
  tryRevive(paneId: string, force = false): boolean {
    const pane = this.session.getPane(paneId);
    if (!pane || pane.kind !== 'web') return false;
    if (!force && (pane.running || this.web.has(paneId))) return false;

    this.reviving.add(paneId);
    this.session.setPaneRunning(paneId, true);
    this.start(paneId);
    return true;
  }

  /** 共享 web 进程意外退出（崩溃等）：收掉所有正在使用它的 pane。 */
  onExit(paneIds: string[]): void {
    for (const paneId of paneIds) this.host.closePane(paneId);
  }

  /**
   * 在运行时向共享 web 进程注册某 pane 的项目 workspace。
   *
   * @param mode `create` 新建会话；`restore` 恢复该 pane 上次的会话（返回 null，不覆盖 partition）。
   */
  private async registerWorkspace(
    port: number,
    cwd: string | null,
    paneId: string,
    mode: 'create' | 'restore',
  ): Promise<string | null> {
    if (!cwd) return null;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/herdr-desktop/register-workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, paneId, mode }),
      });
      const body = (await response.json()) as { sessionId?: string | null };
      return typeof body.sessionId === 'string' ? body.sessionId : null;
    } catch {
      // 回环调用失败忽略：不因 workspace 注册失败而让 pane 启动失败。
      return null;
    }
  }

  /**
   * 通知插件移除某个已关闭 web pane 的广播条目（best-effort）。
   *
   * 插件据此把 paneId 从 cwd 的 Set 里移除，Set 清空后连 cwd 状态一起回收，
   * 避免共享进程长期运行下映射无界增长。进程已死时回环调用失败会被吞掉。
   */
  unregisterWorkspace(port: number, cwd: string, paneId: string): void {
    void fetch(`http://127.0.0.1:${port}/herdr-desktop/register-workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, paneId, mode: 'unregister' }),
    }).catch(() => {
      // 进程已退出或路由未注册时忽略。
    });
  }
}
