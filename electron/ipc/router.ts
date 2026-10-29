/**
 * IPC 路由 —— 对应 herdr server 端命令路由。
 *
 * 将 Renderer 发来的控制命令分发到 Session + PtyManager + SettingsStore，
 * 并把运行时状态变化（结构快照 + 终端数据流）推回 Renderer。
 */

import { BrowserWindow, nativeTheme } from 'electron';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Session } from '../runtime/session';
import { PtyManager } from '../runtime/pty-manager';
import { WebAgentManager } from '../runtime/web-agent-manager';
import { SettingsStore } from '../runtime/settings';
import { resolveWebAgent } from '../../shared/agents/registry';
import { hostEnv } from '../support/host-env';
import { loadState, flushState } from '../runtime/persist';
import { ReportServer } from '../runtime/report-server';

import { hookStatuses, installHook, uninstallHook } from '../integration';
import { DshSessionBinding } from './services/dsh-session-binding';
import { RevivingPanes } from './services/reviving-panes';
import { AgentStateService, type AgentReport } from './services/agent-state-service';
import { PaneLifecycleService } from './services/pane-lifecycle-service';
import { RendererBridge } from './services/renderer-bridge';
import { WebAgentService } from './services/web-agent-service';
import { AgentEnvProbe } from './services/env-probe';
import { IPC } from './channels';
import { registerSettingsHandlers } from './handlers/settings-handlers';
import { registerPaneHandlers } from './handlers/pane-handlers';
import { registerDialogHandlers } from './handlers/dialog-handlers';
import {
  NotificationScheduler,
  type PendingNotification,
} from './notification-scheduler';
import type { MainToRendererMessage, ProxyTestResult, HookStatus } from '../../shared/protocol';
import type {
  AddProjectParams,
  SpawnAgentParams,
  SpawnWebAgentParams,
  ThemePreference,
} from '../../shared/state';

/**
 * 通知投递延迟（对应 herdr 的 `config.ui.toast.delay_seconds`，默认 1 秒）。
 *
 * 这是 herdr 通知机制的核心：通知不立即投递，而是延后 1 秒再按**当时**的 pane 状态
 * 校验一次。屏幕检测的抖动（blocked→working→blocked）通常远小于 1 秒，于是多次跳变
 * 只会被合并成一条，假完成在投递前就已失效、根本不发声。
 */
const NOTIFY_DELIVERY_DELAY_MS = 1_000;
/** 投递前的证据宽限期：期间状态仍在变化就每 50ms 重试，超时则丢弃（对应 COMPLETION_EVIDENCE_GRACE）。 */
const NOTIFY_EVIDENCE_GRACE_MS = 1_000;
/** 队列轮询间隔（对应 COMPLETION_RECHECK_INTERVAL）。 */
const NOTIFY_TICK_MS = 50;

export class IpcRouter {
  private session = new Session();
  private settings = new SettingsStore();
  private pty: PtyManager;
  private web: WebAgentManager;
  /** pane 生命周期（两阶段创建 / 重启 / 恢复 / 关闭）。R4 从本类抽出。 */
  private paneService: PaneLifecycleService;

  private reviving = new RevivingPanes();

  /** web 型智能体的托管（R3 从本类抽出）。 */
  private webService: WebAgentService;

  /** 渲染端输出层（R5 从本类抽出）。 */
  private renderer: RendererBridge;

  /** 状态上报与仲裁（R6 从本类抽出）。 */
  private state: AgentStateService;
  /** hook 上报端点（官方集成 hook 把会话引用报回 Main）。 */
  private reportServer = new ReportServer();
  /** 通知调度：延迟投递 + 投递前证据复核（见 NotificationScheduler）。 */
  /** 命令可用性探测（登录 shell PATH 解析 + 缓存）。 */
  private envProbe = new AgentEnvProbe();
  private notifications = new NotificationScheduler({
    deliveryDelayMs: NOTIFY_DELIVERY_DELAY_MS,
    evidenceGraceMs: NOTIFY_EVIDENCE_GRACE_MS,
    tickMs: NOTIFY_TICK_MS,
    currentState: (paneId) => this.session.detectedStateFor(paneId),
    deliver: (item) => this.deliverNotification(item),
  });
  /**
   * dsh web pane 当前正在查看的会话绑定：sessionId → Set<paneId>。
   *
   * 由渲染端 WebPane 轮询 webview 的 localStorage 后通过 `dsh:bind-session`
   * 上报，用于把插件的 per-session 状态报告路由到正确的 pane（而不是按 cwd 广播）。
   */
  /** dsh 会话 → pane 绑定表（共享进程里的多会话路由）。 */
  private dshBinding = new DshSessionBinding();

  /**
   * 标题栏配色回调，由主进程在创建窗口后注入。
   *
   * 原生 titleBarOverlay 的颜色不受渲染侧 CSS 控制，需要显式同步。
   */
  onTitleBarTheme?: (color: string, symbolColor: string) => void;
  /**
   * 语言切换后回调，由主进程注入，用于重建应用菜单（菜单文案随语言变化）。
   */
  onLanguageChange?: () => void;
  /**
   * 快捷键覆盖变化后回调，由主进程注入，用于重建应用菜单（accelerator 随覆盖变化）。
   */
  onShortcutsChange?: () => void;

  constructor() {
    this.pty = new PtyManager({
      onData: (paneId, data) => {
        this.broadcast({ type: IPC.PTY_DATA, payload: { paneId, data } });
        // 数据到达时基于快照更新 agent 状态
        this.refreshAgent(paneId);
      },
      onExit: (paneId, exitCode, signal) => {
        this.pty.kill(paneId);
        this.session.closePane(paneId);
        this.reviveFocusedPaneIfStopped();
        this.broadcast({
          type: IPC.PTY_EXIT,
          payload: { paneId, exitCode, signal: signal ?? null },
        });
        this.pushSnapshot();
      },
    });

    /*
     * web 型智能体的服务托管器。
     *
     * 注意：`web` 是宿主形态，不是具体智能体。这里取「默认 web 型智能体」
     * （当前是 dsh）构造托管器，并把它的 descriptor 传进去 —— 托管器内部
     * 不再写死 dsh。将来若出现第二个 web 型智能体，需要按 agentId 维护
     * 多个托管器（或在 descriptor 上声明「如何判定就绪」）。
     */
    const defaultWebAgent = resolveWebAgent();
    if (!defaultWebAgent) {
      throw new Error('no web-type agent registered');
    }
    this.web = new WebAgentManager(
      { onExit: (paneIds, exitCode) => this.onWebExit(paneIds, exitCode) },
      defaultWebAgent,
      hostEnv(),
    );

    // web 型智能体的托管委托给它（R3 从本类抽出）。
    this.webService = new WebAgentService(this.session, this.web, this.reviving, {
      pushError: (titleKey, titleVars, extra) => this.pushError(titleKey, titleVars, extra),
      pushSnapshot: () => this.pushSnapshot(),
      broadcast: (message) => this.broadcast(message),
      launchEnvFor: (agentId) => this.launchEnvFor(agentId),
      injectHookEnv: (env, paneId, command) => this.injectHookEnv(env, paneId, command),
      closePane: (paneId) => this.closePane(paneId),
    });

    this.renderer = new RendererBridge(this.session, this.settings);

    // pane 生命周期服务（R4 从本类抽出）。
    this.paneService = new PaneLifecycleService(
      this.session,
      this.pty,
      this.web,
      this.settings,
      this.reportServer,
      this.reviving,
      {
        pushError: (titleKey, titleVars, extra) => this.pushError(titleKey, titleVars, extra),
        pushSnapshot: () => this.pushSnapshot(),
        broadcast: (message) => this.broadcast(message),
        bindDshSession: (paneId, sessionId) => this.bindDshSession(paneId, sessionId),
        tryReviveWeb: (paneId, force) => this.tryReviveWeb(paneId, force),
        unregisterWorkspace: (port, cwd, paneId) =>
          this.webService.unregisterWorkspace(port, cwd, paneId),
      },
    );

    // 状态上报与仲裁服务（R6 从本类抽出）。
    this.state = new AgentStateService(
      this.session,
      this.pty,
      this.notifications,
      this.dshBinding,
      {
        pushError: (titleKey, titleVars, extra) => this.pushError(titleKey, titleVars, extra),
        pushSnapshot: () => this.pushSnapshot(),
      },
    );
  }

  /** 加载持久化设置（app ready 后、创建窗口前调用）。 */
  loadSettings(): void {
    this.settings.loadSync();
    this.syncNativeTheme(this.settings.get().theme);
  }

  /**
   * 让 Electron 原生主题跟随应用主题。
   *
   * `nativeTheme.themeSource` 决定所有 webContents（含 <webview>）里的
   * `prefers-color-scheme`。DSH Web 的主题偏好默认为 `system`，即用
   * `prefers-color-scheme` 解析深浅色并监听变化，因此这一步能让内嵌的
   * DSH Web GUI 跟随 herdr-desktop 的主题切换实时换肤。
   */
  private syncNativeTheme(theme: ThemePreference): void {
    nativeTheme.themeSource = theme;
  }

  /**
   * 恢复上次会话（app ready 后、创建窗口前调用）。
   *
   * 只恢复项目/pane/agent 的元数据，PTY 不会自动拉起——
   * 恢复出的 pane 标记为 stopped，由用户在界面上点击「重新启动」。
   * did-finish-load 推送快照时会一并带到渲染端。
   */
  async restoreSession(): Promise<void> {
    const saved = await loadState();
    if (!saved) return;
    try {
      this.session.restore(saved);
    } catch (error) {
      // 损坏的快照不应阻止应用启动，按全新会话处理
      console.error('[herdr-desktop] session restore failed:', error);
    }
  }

  /** 退出前确保挂起的持久化写入落盘（before-quit 调用）。 */
  async flush(): Promise<void> {
    await flushState();
  }

  /** 退出前释放状态服务的定时器（before-quit 调用）。 */
  disposeAgentState(): void {
    this.state.dispose();
  }

  /** 退出前结束所有 dsh web 子进程树（before-quit 调用）。 */
  disposeWebAgents(): void {
    this.web.disposeAll();
  }

  /** 启动 hook 上报端点（app ready 后、spawn 任何 agent 之前调用）。 */
  async startHookServer(): Promise<void> {
    await this.reportServer.start((report) => {
      /*
       * 整条透传，不要逐字段重建。
       *
       * 之前这里是把 report 的字段一个个抄进新对象，结果新增 `heartbeat` 时漏了一行，
       * 导致 claude 的心跳判定在 router 边界变成永远 undefined（是个静默失效的死代码：
       * 单测直接打 TerminalState，看不见这层丢字段）。整条透传从结构上根除这一类问题。
       */
      this.reportAgentSession(report.paneId, report);
    });
  }

  /** 退出前关闭 hook 上报端点（before-quit 调用）。 */
  disposeHookServer(): void {
    this.reportServer.stop();
  }

  /** 各 agent 的 hook 安装状态（设置页使用）。 */
  getHookStatuses(): Record<string, HookStatus> {
    return hookStatuses();
  }

  /** 安装某 agent 的官方集成 hook。 */
  async installHook(agentId: string): Promise<HookStatus> {
    const status = await installHook(agentId);
    // 安装状态变化会影响「完成判定是否交给 hook」，清缓存重新判断
    this.state.clearCompletionCache();
    return status;
  }

  /** 卸载某 agent 的官方集成 hook。 */
  async uninstallHook(agentId: string): Promise<HookStatus> {
    const status = await uninstallHook(agentId);
    this.state.clearCompletionCache();
    return status;
  }

  getSettings() {
    return this.settings.get();
  }

  /** 菜单/快捷键调整终端字号（View 菜单使用）。持久化并回推设置。 */
  setFontSize(fontSize: number): void {
    void this.settings.setFontSize(fontSize).then((settings) => this.pushSettings(settings));
  }

  /**
   * 注册全部 IPC 通道。
   *
   * 按关注点分三组，各自的注册逻辑在 `handlers/` 下：
   * - 设置与外观（主题/语言/字号/代理/声音/快捷键）
   * - 项目与 pane 生命周期（增删项目、创建/挂载/重启/关闭/聚焦、高频子命令）
   * - 桌面能力（目录选择、可用性探测、代理检测）
   *
   * 本方法只负责把自身能力以窄接口的形式传进去。
   */
  register(): void {
    registerSettingsHandlers({
      settings: this.settings,
      pushSettings: (settings) => this.pushSettings(settings),
      syncNativeTheme: (theme) => this.syncNativeTheme(theme),
      onTitleBarTheme: this.onTitleBarTheme,
      onLanguageChange: this.onLanguageChange,
      onShortcutsChange: this.onShortcutsChange,
      setShortcutCaptureMode: (capturing) => this.setShortcutCaptureMode(capturing),
    });

    registerPaneHandlers({
      addProject: (params) => this.addProject(params),
      removeProject: (projectId) => this.removeProject(projectId),
      toggleProject: (projectId, collapsed) => {
        this.session.toggleProject(projectId, collapsed);
        this.pushSnapshot();
      },
      spawnAgent: (params) => this.spawnAgent(params),
      spawnWebAgent: (params) => this.spawnWebAgent(params),
      attachPane: (paneId) => this.attachPane(paneId),
      respawnPane: (paneId, force) => this.respawnPane(paneId, force),
      closePane: (paneId) => this.closePane(paneId),
      focusPane: (paneId) => this.focusPane(paneId),
      handleNamed: (payload) => this.handleNamed(payload),
    });

    registerDialogHandlers(
      { probeAgentAvailability: (commands) => this.probeAgentAvailability(commands) },
      (url) => testProxy(url),
    );
  }

  /**
   * 改键捕获期间：忽略菜单快捷键，让 keydown 到达渲染层。
   *
   * 菜单 accelerator（如当前已注册的 CmdOrCtrl+Shift+X）会先于渲染层 keydown
   * 被消费，不忽略的话无法把这类组合键捕获下来。结束捕获时恢复。
   */
  private setShortcutCaptureMode(capturing: boolean): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.setIgnoreMenuShortcuts(capturing);
    }
  }

  /**
   * 高频命名子命令（对应 herdr 的 EndpointControl）。
   *
   * payload 的 `data` 是 JSON 字符串（渲染端把高频命令压成单字符串以避免
   * 结构化克隆开销）。这里**按 kind 逐个解析并校验**，而不是用一个 try/catch
   * 包住整个 switch —— 那样连 `pty.write` 的真实运行时错误也会被静默吞掉，
   * 排查时只知道「什么都没发生」。
   */
  private handleNamed(payload: { kind: string; data: string }): void {
    switch (payload.kind) {
      case 'pty:write': {
        const parsed = parseNamedPayload<{ paneId: string; data: string }>(payload);
        if (!parsed || typeof parsed.paneId !== 'string' || typeof parsed.data !== 'string') return;
        this.pty.write(parsed.paneId, parsed.data);
        return;
      }
      case 'pty:resize': {
        const parsed = parseNamedPayload<{ paneId: string; cols: number; rows: number }>(payload);
        if (!parsed || typeof parsed.paneId !== 'string') return;
        /*
         * 进程未启动时暂存尺寸，供 attachPane 使用。
         * 这是两阶段创建的关键一环：终端先量出精确尺寸，PTY 用它启动。
         */
        if (this.paneService.hasPendingSpawn(parsed.paneId) && !this.pty.has(parsed.paneId)) {
          this.paneService.stashPendingSize(parsed.paneId, parsed.cols, parsed.rows);
          return;
        }
        this.pty.resize(parsed.paneId, parsed.cols, parsed.rows);
        return;
      }
      case 'agent:report-session': {
        const parsed = parseNamedPayload<AgentReport & { paneId: string }>(payload);
        if (!parsed || typeof parsed.paneId !== 'string' || typeof parsed.source !== 'string') return;
        const { paneId, ...report } = parsed;
        this.reportAgentSession(paneId, report);
        return;
      }
      case 'dsh:bind-session': {
        const parsed = parseNamedPayload<{ paneId: string; sessionId: string | null }>(payload);
        if (!parsed || typeof parsed.paneId !== 'string') return;
        this.bindDshSession(parsed.paneId, parsed.sessionId ?? null);
        return;
      }
      default:
        return;
    }
  }


  private addProject(params: AddProjectParams): void {
    this.paneService.addProject(params);
  }

  private removeProject(projectId: string): void {
    this.paneService.removeProject(projectId);
  }

  /**
   * 渲染端输出全部委托给 RendererBridge（R5 抽出）。
   * 保留同名方法是为了让散布在各簇里的 30 多个调用点保持不变。
   */
  private broadcast(message: MainToRendererMessage): void {
    this.renderer.broadcast(message);
  }

  private pushSnapshot(): void {
    this.renderer.pushSnapshot();
  }

  private pushSettings(settings: ReturnType<SettingsStore['get']>): void {
    this.renderer.pushSettings(settings);
  }

  private pushError(
    titleKey: string,
    titleVars?: Record<string, string | number>,
    extra?: { messageKey?: string; paneId?: string; projectId?: string },
  ): void {
    this.renderer.pushError(titleKey, titleVars, extra);
  }

  private deliverNotification(item: PendingNotification): void {
    this.renderer.deliverNotification(item);
  }

  /** 首次连接时推送完整快照 + 设置。 */
  pushSnapshotTo(win: BrowserWindow): void {
    this.renderer.pushSnapshotTo(win);
  }


  /**
   * web 型智能体的托管全部委托给 WebAgentService（R3 抽出）。
   * 保留同名私有方法是为了让调用点（register / handleNamed / onWebExit 等）不变。
   */
  private spawnWebAgent(params: SpawnWebAgentParams): void {
    this.webService.spawn(params);
  }

  private tryReviveWeb(paneId: string, force = false): boolean {
    return this.webService.tryRevive(paneId, force);
  }

  private onWebExit(paneIds: string[], _exitCode: number): void {
    this.webService.onExit(paneIds);
  }

  private spawnAgent(params: SpawnAgentParams): void {
    this.paneService.spawn(params);
  }







  private reportAgentSession(paneId: string, report: AgentReport): void {
    this.state.reportSession(paneId, report);
  }




  private bindDshSession(paneId: string, sessionId: string | null): void {
    this.state.bindDshSession(paneId, sessionId);
  }


  private respawnPane(paneId: string, force: boolean): void {
    this.paneService.respawn(paneId, force);
  }




  private attachPane(paneId: string): void {
    this.paneService.attach(paneId);
  }

  private launchEnvFor(agentId: string | null): Record<string, string> {
    return this.paneService.launchEnvFor(agentId);
  }

  private injectHookEnv(env: Record<string, string>, paneId: string, command: string): void {
    this.paneService.injectHookEnv(env, paneId, command);
  }


  /**
   * 用于**探测**智能体是否安装的 PATH（懒加载并缓存）。
   *
   * 为什么不能直接用 `process.env.PATH`：从 Finder / Dock 启动的 macOS 应用
   * 只继承一份极简 PATH（通常 `/usr/bin:/bin:/usr/sbin:/sbin`），
   * homebrew（`/opt/homebrew/bin`）、npm global、`~/.local/bin` 全都不在其中，
   * 于是「明明装了 claude 却显示未安装」。
   *
   * 这里复用启动 PTY 时用的同一份登录 shell 环境，保证「探测」与「启动」
   * 看到的是同一个 PATH——探测得到的结论一定可执行。
   *
   * `resolveLaunchEnv()` 要起一个 `shell -ilc env` 子进程（百毫秒级），
   * 所以只在首次探测时解析一次并缓存；设置页刷新探测也走缓存。
   */
  /** 探测本机 agent 命令可用性（实现见 services/env-probe.ts）。 */
  probeAgentAvailability(commands: string[]): Record<string, boolean> {
    return this.envProbe.probe(commands);
  }

  private reviveFocusedPaneIfStopped(): void {
    this.paneService.reviveFocusedIfStopped();
  }

  private closePane(paneId: string): void {
    this.paneService.close(paneId);
  }

  private focusPane(paneId: string): void {
    this.paneService.focus(paneId);
  }


  private refreshAgent(paneId: string): void {
    this.state.refresh(paneId);
  }










}

/** 检测请求的目标：一个稳定、轻量、对代理友好的 HTTPS 端点。 */
const PROXY_TEST_TARGET = 'https://www.gstatic.com/generate_204';
const PROXY_TEST_TIMEOUT_MS = 6000;

/**
 * 检测代理是否可用：经该代理发起一次真实 HTTPS 请求。
 *
 * 用 CONNECT 隧道而非普通 HTTP 请求——agent 走的多是 HTTPS，
 * 只有 CONNECT 成功才说明这个代理真能承载它们的流量。
 *
 * 地址非法时直接返回 invalid，不去发起连接：像 `127.0.0.0.1` 这种
 * 五段数字不是合法 IP 字面量，会被底层当成主机名去做 DNS 查询，
 * 报出难以理解的 `lookup ...: no such host`，在设置界面就拦下来更清楚。
 */
function testProxy(rawUrl: unknown): Promise<ProxyTestResult> {
  return new Promise((resolve) => {
    if (typeof rawUrl !== 'string') {
      resolve({ ok: false, reason: 'invalid', detail: 'empty' });
      return;
    }
    const input = rawUrl.trim();
    if (!input) {
      resolve({ ok: false, reason: 'invalid', detail: 'empty' });
      return;
    }

    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input) ? input : `http://${input}`;

    /*
     * 先在原始串上检查主机部分：`new URL()` 会拒绝 `127.0.0.0.1` 这类
     * 非法 IPv4（报 unparsable），但那个报错对用户毫无信息量。
     * 提前识别「全数字点分但格式不对」的情况，给出准确的 bad-ip 提示。
     */
    const rawHost = withScheme
      .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
      .replace(/^[^@/]*@/, '')
      .split(/[/?#]/)[0]
      .replace(/:\d*$/, '');
    if (/^[\d.]+$/.test(rawHost) && !isValidIpv4(rawHost)) {
      resolve({ ok: false, reason: 'invalid', detail: 'bad-ip' });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(withScheme);
    } catch {
      resolve({ ok: false, reason: 'invalid', detail: 'unparsable' });
      return;
    }

    // 代理协议只支持 http/https：socks 需要额外依赖，这里明确不支持而非静默失败。
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      resolve({ ok: false, reason: 'invalid', detail: parsed.protocol.replace(':', '') });
      return;
    }
    if (!parsed.hostname || !parsed.port) {
      resolve({ ok: false, reason: 'invalid', detail: 'missing-port' });
      return;
    }

    const started = Date.now();
    const target = new URL(PROXY_TEST_TARGET);

    const transport = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = transport({
      host: parsed.hostname,
      port: Number(parsed.port),
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers: { Host: `${target.hostname}:443` },
      auth: parsed.username
        ? `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
        : undefined,
    });

    req.setTimeout(PROXY_TEST_TIMEOUT_MS, () => {
      req.destroy();
      resolve({ ok: false, reason: 'timeout' });
    });

    req.on('connect', (res) => {
      // 200 表示隧道建立成功；407 是代理要求认证。
      const ok = res.statusCode === 200;
      req.destroy();
      resolve(
        ok
          ? { ok: true, latencyMs: Date.now() - started }
          : { ok: false, reason: 'connect', detail: String(res.statusCode) },
      );
    });

    req.on('response', (res) => {
      // 非 CONNECT 语义的响应（某些代理会直接回 HTTP 响应）
      req.destroy();
      resolve({ ok: false, reason: 'connect', detail: String(res.statusCode) });
    });

    req.on('error', (err: Error) => {
      resolve({ ok: false, reason: 'connect', detail: err.message });
    });

    req.end();
  });
}

/** 严格校验点分十进制 IPv4：四段、每段 0-255、无前导零歧义。 */
function isValidIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith('0')) return false;
    return Number(part) <= 255;
  });
}

/**
 * 解析 named 子命令的 JSON payload。
 *
 * 单独成函数是为了让畸形输入的处理**只发生一次**：解析失败返回 null 并且只在
 * 这一层吞掉 SyntaxError，调用方的业务逻辑不再被宽 try/catch 包住 ——
 * 否则 `pty.write` 之类的真实运行时错误也会被静默丢弃。
 */
function parseNamedPayload<T>(payload: { data: string }): T | null {
  try {
    const parsed: unknown = JSON.parse(payload.data);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as T;
  } catch {
    // 畸形 payload（渲染端 bug 或版本不匹配）：丢弃即可，不当作错误上报
    return null;
  }
}
