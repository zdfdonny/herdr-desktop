/**
 * IPC 路由 —— 对应 herdr server 端命令路由。
 *
 * 将 Renderer 发来的控制命令分发到 Session + PtyManager + SettingsStore，
 * 并把运行时状态变化（结构快照 + 终端数据流）推回 Renderer。
 */

import { BrowserWindow, ipcMain, dialog, nativeTheme } from 'electron';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Session } from '../runtime/session';
import { HOOK_WORKING_TTL_MS, type TerminalStateMutation } from '../runtime/terminal-state';
import { PtyManager } from '../runtime/pty-manager';
import { WebAgentManager } from '../runtime/web-agent-manager';
import { SettingsStore } from '../runtime/settings';
import { detectFromSnapshot } from '../runtime/agent-detector';
import { parseAgentLabel, screenCompletionIgnored } from '../../shared/detect-manifest';
import { isCompletionTransition } from '../../shared/agent-status';
import { detectGitBranch } from '../runtime/git';
import { saveState, loadState, flushState } from '../runtime/persist';
import * as agentResume from '../runtime/agent-resume';
import { ReportServer } from '../runtime/report-server';
import { hookStatuses, installHook, uninstallHook } from '../runtime/integration';
import { resolveLaunchEnv, isCommandAvailable } from '../platform';
import { IPC } from './protocol';
import type { MainToRendererMessage, ProxyTestResult, HookStatus } from '../../shared/protocol';
import type {
  AddProjectParams,
  SpawnAgentParams,
  SpawnWebAgentParams,
  PaneState,
  ThemePreference,
  Language,
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

/** 一条待投递的通知。 */
interface PendingNotify {
  paneId: string;
  status: 'blocked' | 'done';
  message?: string;
  /** 计划投递时间。 */
  deliverAt: number;
  /** 证据宽限截止时间：超过后不再等待状态稳定，直接按当时的校验结果决定丢弃。 */
  expiresAt: number;
}

export class IpcRouter {
  private session = new Session();
  private settings = new SettingsStore();
  private pty: PtyManager;
  private web: WebAgentManager;
  /** 等待终端就绪的 spawn 请求（两阶段创建的中间态）。 */
  private pendingSpawns = new Map<string, SpawnAgentParams>();
  /**
   * 终端上报的尺寸，但 PTY 尚未启动时暂存。
   *
   * 渲染侧会在挂载后立刻 resize 一次；此时进程还没起，
   * 丢掉这次尺寸会让 spawn 回退到默认值，TUI 首屏就会错位。
   */
  private pendingSizes = new Map<string, { cols: number; rows: number }>();
  /**
   * 正在走「重启恢复」流程的 pane。
   *
   * 区别于新建 spawn：重启失败时**保留** pane 条目（只是回到停止态），
   * 否则一次失败的恢复会把用户的项目结构也一并清掉。
   */
  private revivingPanes = new Set<string>();
  /**
   * 探测智能体用的 PATH 缓存（首次探测时从登录 shell 解析）。
   * `null` 表示尚未解析。见 `detectionPath()`。
   */
  private detectionPathCache: string | null = null;
  /** hook 上报端点（官方集成 hook 把会话引用报回 Main）。 */
  private reportServer = new ReportServer();
  /**
   * 待投递的 agent 状态通知队列（对应 herdr `pending_notifications`）。
   *
   * 同一 pane 至多保留一条（新通知替换旧的），靠投递前的状态校验过滤掉抖动产生的
   * 假完成/假阻塞——取代了原先的时间冷却窗口。
   */
  private pendingNotifies: PendingNotify[] = [];
  /** 通知队列的轮询定时器（队列空即停）。 */
  private notifyTicker: NodeJS.Timeout | null = null;
  /**
   * 「hook 的 working 上报到期」定时器（paneId → timer）。
   *
   * TTL 只在有事件时才被求值：用户按 Esc 取消后 TUI 只重绘一次（那时还没到 TTL），
   * 之后就静止等输入、不再产生 PTY 数据，状态机也就再没机会重新评估，于是永久卡在
   * working。这里在收到 working 上报时挂一个到期定时器，到期主动重跑一次屏幕检测，
   * 让状态回落。
   */
  private hookWorkingExpiry = new Map<string, NodeJS.Timeout>();
  /**
   * 「该 agent 的完成判定是否交给集成 hook」的缓存（agent → bool）。
   *
   * 判断要读集成安装状态（`hookStatuses()` 会遍历所有集成做文件 stat），不能每块
   * PTY 数据都算一次；安装/卸载集成后清空即可。
   */
  private hookCompletionCache = new Map<string, boolean>();
  /**
   * dsh web pane 当前正在查看的会话绑定：sessionId → Set<paneId>。
   *
   * 由渲染端 WebPane 轮询 webview 的 localStorage 后通过 `dsh:bind-session`
   * 上报，用于把插件的 per-session 状态报告路由到正确的 pane（而不是按 cwd 广播）。
   */
  private dshSessionBinding = new Map<string, Set<string>>();

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

    this.web = new WebAgentManager({
      onExit: (paneIds, exitCode) => this.onWebExit(paneIds, exitCode),
    });
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
    const status = await installHook(agentId, this.reportServer.reportUrl);
    // 安装状态变化会影响「完成判定是否交给 hook」，清缓存重新判断
    this.hookCompletionCache.clear();
    return status;
  }

  /** 卸载某 agent 的官方集成 hook。 */
  async uninstallHook(agentId: string): Promise<HookStatus> {
    const status = await uninstallHook(agentId);
    this.hookCompletionCache.clear();
    return status;
  }

  getSettings() {
    return this.settings.get();
  }

  /** 菜单/快捷键调整终端字号（View 菜单使用）。持久化并回推设置。 */
  setFontSize(fontSize: number): void {
    void this.settings.setFontSize(fontSize).then((settings) => this.pushSettings(settings));
  }

  register(): void {
    ipcMain.on(IPC.ADD_PROJECT, (_event, params: AddProjectParams) => {
      this.addProject(params);
    });
    ipcMain.on(IPC.REMOVE_PROJECT, (_event, payload: { projectId: string }) => {
      this.removeProject(payload.projectId);
    });
    ipcMain.on(
      IPC.TOGGLE_PROJECT,
      (_event, payload: { projectId: string; collapsed: boolean }) => {
        this.session.toggleProject(payload.projectId, payload.collapsed);
        this.pushSnapshot();
      },
    );
    ipcMain.on(IPC.SPAWN_AGENT, (_event, params: SpawnAgentParams) => {
      this.spawnAgent(params);
    });
    ipcMain.on(IPC.SPAWN_WEB_AGENT, (_event, params: SpawnWebAgentParams) => {
      this.spawnWebAgent(params);
    });
    ipcMain.on(IPC.ATTACH_PANE, (_event, payload: { paneId: string }) => {
      this.attachPane(payload.paneId);
    });
    ipcMain.on(IPC.RESPAWN_PANE, (_event, payload: { paneId: string; force?: boolean }) => {
      this.respawnPane(payload.paneId, payload.force === true);
    });
    ipcMain.on(IPC.CLOSE_PANE, (_event, payload: { paneId: string }) => {
      this.closePane(payload.paneId);
    });
    ipcMain.on(IPC.FOCUS_PANE, (_event, payload: { paneId: string }) => {
      this.focusPane(payload.paneId);
    });
    ipcMain.on(IPC.SET_THEME, (_event, payload: { theme: ThemePreference }) => {
      void this.settings.setTheme(payload.theme).then((settings) => {
        this.syncNativeTheme(settings.theme);
        this.pushSettings(settings);
      });
    });
    ipcMain.on(
      IPC.SET_TITLEBAR_THEME,
      (_event, payload: { color: string; symbolColor: string }) => {
        this.onTitleBarTheme?.(payload.color, payload.symbolColor);
      },
    );
    ipcMain.on(IPC.SET_LANGUAGE, (_event, payload: { language: Language }) => {
      void this.settings
        .setLanguage(payload.language)
        .then((settings) => {
          this.pushSettings(settings);
          this.onLanguageChange?.();
        });
    });
    ipcMain.on(IPC.SET_FONT_SIZE, (_event, payload: { fontSize: number }) => {
      void this.settings
        .setFontSize(payload.fontSize)
        .then((settings) => this.pushSettings(settings));
    });
    ipcMain.on(IPC.SET_PROXY_URL, (_event, payload: { url: string }) => {
      void this.settings.setProxyUrl(payload.url).then((settings) => this.pushSettings(settings));
    });
    ipcMain.on(
      IPC.SET_AGENT_PROXY,
      (_event, payload: { command: string; enabled: boolean }) => {
        void this.settings
          .setAgentProxy(payload.command, payload.enabled)
          .then((settings) => this.pushSettings(settings));
      },
    );
    ipcMain.on(
      IPC.SET_INTEGRATIONS_ONBOARDED,
      (_event, payload: { onboarded: boolean }) => {
        void this.settings
          .setIntegrationsOnboarded(payload.onboarded)
          .then((settings) => this.pushSettings(settings));
      },
    );
    ipcMain.on(IPC.SET_SOUND_ENABLED, (_event, payload: { enabled: boolean }) => {
      void this.settings.setSoundEnabled(payload.enabled).then((settings) => this.pushSettings(settings));
    });
    ipcMain.on(IPC.SET_TOAST_ENABLED, (_event, payload: { enabled: boolean }) => {
      void this.settings.setToastEnabled(payload.enabled).then((settings) => this.pushSettings(settings));
    });
    ipcMain.on(IPC.NAMED, (_event, payload: { kind: string; data: string }) => {
      this.handleNamed(payload);
    });
    ipcMain.on(
      IPC.SET_SHORTCUT,
      (_event, payload: { action: string; accelerator: string | null }) => {
        void this.settings.setShortcut(payload.action, payload.accelerator).then((settings) => {
          this.pushSettings(settings);
          this.onShortcutsChange?.();
        });
      },
    );
    ipcMain.on(IPC.RESET_SHORTCUTS, () => {
      void this.settings.resetShortcuts().then((settings) => {
        this.pushSettings(settings);
        this.onShortcutsChange?.();
      });
    });
    ipcMain.on(IPC.BEGIN_SHORTCUT_CAPTURE, () => this.setShortcutCaptureMode(true));
    ipcMain.on(IPC.END_SHORTCUT_CAPTURE, () => this.setShortcutCaptureMode(false));

    // 目录选择对话框（添加项目）
    ipcMain.handle('herdr:pick-directory', async (_event, options?: { title?: string }) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      // 对话框标题由 Renderer 按当前语言给出，Main 不产出本地化文案
      const title = options?.title ?? 'Add project';
      const dialogOptions: Electron.OpenDialogOptions = {
        title,
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: title,
      };
      const result = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    });

    // agent 命令可用性探测
    ipcMain.handle('herdr:agent-availability', (_event, commands: string[]) => {
      return this.probeAgentAvailability(Array.isArray(commands) ? commands : []);
    });

    // 代理连通性检测
    ipcMain.handle('herdr:test-proxy', (_event, url: string) => {
      return testProxy(url);
    });
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

  private handleNamed(payload: { kind: string; data: string }): void {    try {
      switch (payload.kind) {
        case 'pty:write': {
          const { paneId, data } = JSON.parse(payload.data) as { paneId: string; data: string };
          this.pty.write(paneId, data);
          break;
        }
        case 'pty:resize': {
          const { paneId, cols, rows } = JSON.parse(payload.data) as {
            paneId: string;
            cols: number;
            rows: number;
          };
          /*
           * 进程未启动时暂存尺寸，供 attachPane 使用。
           * 这是两阶段创建的关键一环：终端先量出精确尺寸，PTY 用它启动。
           */
          if (this.pendingSpawns.has(paneId) && !this.pty.has(paneId)) {
            this.pendingSizes.set(paneId, { cols, rows });
            break;
          }
          this.pty.resize(paneId, cols, rows);
          break;
        }
        case 'agent:report-session': {
          const { paneId, source, agent, sessionId, sessionPath, state, seq, message, sessionStartSource, heartbeat } = JSON.parse(payload.data) as {
            paneId: string;
            source: string;
            agent: string;
            sessionId?: string | null;
            sessionPath?: string | null;
            state?: 'working' | 'blocked' | 'idle' | 'done' | null;
            seq?: number | null;
            message?: string | null;
            sessionStartSource?: string | null;
            heartbeat?: boolean;
          };
          this.reportAgentSession(paneId, { source, agent, sessionId, sessionPath, state, seq, message, sessionStartSource, heartbeat });
          break;
        }
        case 'dsh:bind-session': {
          const { paneId, sessionId } = JSON.parse(payload.data) as {
            paneId: string;
            sessionId: string | null;
          };
          this.bindDshSession(paneId, sessionId);
          break;
        }
        default:
          break;
      }
    } catch {
      // 忽略畸形 named payload
    }
  }

  /** 首次连接时推送完整快照 + 设置。 */
  pushSnapshotTo(win: BrowserWindow): void {
    win.webContents.send(IPC.STATE_SNAPSHOT, {
      type: IPC.STATE_SNAPSHOT,
      version: 1,
      payload: this.session.snapshot(),
    } satisfies MainToRendererMessage);
    win.webContents.send(IPC.STATE_SETTINGS, {
      type: IPC.STATE_SETTINGS,
      version: 1,
      payload: this.settings.get(),
    } satisfies MainToRendererMessage);
  }

  private addProject(params: AddProjectParams): void {
    if (!params.path) return;
    const project = this.session.addProject(params);
    this.pushSnapshot();

    // 异步探测 git 分支并回填（不阻塞项目添加，失败保持 null）
    void detectGitBranch(project.path).then((branch) => {
      this.session.setProjectBranch(project.projectId, branch);
      this.pushSnapshot();
    });
  }

  private removeProject(projectId: string): void {
    const paneIds = this.session.removeProject(projectId);
    for (const paneId of paneIds) {
      this.pty.kill(paneId);
      this.web.release(paneId);
    }
    this.pushSnapshot();
  }

  /**
   * 第一阶段：创建 pane，但**不**启动 PTY。
   *
   * 渲染侧会先挂载终端、量出精确的 cols/rows，再调用 attachPane 启动进程。
   * 这样 TUI 从第一帧起就按正确尺寸排版，避免「先按错误尺寸绘制再被 resize 打断」
   * 造成的首屏错位（opencode 的整个界面会画到可视区之外）。
   */
  private spawnAgent(params: SpawnAgentParams): void {
    if (!params.projectId) {
      this.pushError('error.noProject', undefined, { messageKey: 'error.noProjectDetail' });
      return;
    }

    let pane: ReturnType<Session['createAgent']>;
    try {
      pane = this.session.createAgent(params);
    } catch {
      this.pushError('error.projectNotFound', { id: params.projectId }, {
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
    this.pushSnapshot();
  }

  /** 创建 DeepSeek Harness Web agent（新建路径）。 */
  private spawnWebAgent(params: SpawnWebAgentParams): void {
    if (!params.projectId) {
      this.pushError('error.noProject', undefined, { messageKey: 'error.noProjectDetail' });
      return;
    }

    let pane: ReturnType<Session['createWebAgent']>;
    try {
      pane = this.session.createWebAgent(params);
    } catch {
      this.pushError('error.projectNotFound', { id: params.projectId }, {
        messageKey: 'error.projectNotFoundDetail',
      });
      return;
    }

    this.startWebAgent(pane.paneId);
    this.pushSnapshot();
  }

  /**
   * 启动某个 web pane 的 dsh web 子进程（新建与恢复共用）。
   *
   * 就绪前 pane 已标记 running、webUrl 为 null，渲染端显示「正在启动」；
   * 就绪后回填 webUrl 并推送 `web:ready`（带认证链接）。
   */
  private startWebAgent(paneId: string): void {
    const pane = this.session.getPane(paneId);
    if (!pane || pane.kind !== 'web') return;
    // 新建 vs 恢复/重启：新建需要新会话，恢复/重启需要恢复该 pane 上次的会话。
    const restore = this.revivingPanes.has(paneId);

    const env = this.launchEnvFor('dsh');
    /*
     * 注入 Herdr 标记环境变量（HERDR_DESKTOP_REPORT_URL 等），让 dsh 侧的
     * herdr-desktop-agent-state 插件知道这是 Herdr 启动的进程，进而把项目目录
     * 注册为 DSH 工作区（定位项目目录）。
     */
    this.injectHookEnv(env, paneId, 'dsh');
    // 显式带项目目录，插件用它注册工作区（不依赖 process.cwd()，防 dsh chdir）。
    if (pane.cwd) env.HERDR_DESKTOP_CWD = pane.cwd;
    void this.web.acquire(paneId, env, pane.cwd ?? undefined).then(async (result) => {
      if (result.ok) {
        // pane 可能在共享进程启动期间被关闭：清理掉这次遗留的引用，
        // 避免它把共享进程的引用计数卡住、导致无法回收。
        if (!this.session.getPane(paneId)) {
          this.web.release(paneId);
          return;
        }
        this.revivingPanes.delete(paneId);
        // 共享单进程只在首次 spawn 拿到 env/cwd，第二个及后续项目需要在运行时
        // 通过插件暴露的本地路由把 cwd 注册进去，否则 dsh 工作目录会停留在首项目。
        // 新建模式：插件新建空白会话并返回其 id；恢复模式：插件返回 null（不覆盖
        // 该 pane partition 里已有的 localStorage，让 GUI 恢复它上次的会话）。
        const landingSessionId = await this.registerDshWorkspace(
          result.port,
          pane.cwd ?? null,
          paneId,
          restore ? 'restore' : 'create',
        );
        this.session.setPaneWebUrl(paneId, result.cleanUrl);
        // 记录共享进程端口（informational；端口由共享进程统一持有）。
        this.session.setPanePort(paneId, result.port);
        this.broadcast({
          type: IPC.WEB_READY,
          payload: { paneId, url: result.url, sessionId: landingSessionId },
        });
        this.pushSnapshot();
        return;
      }

      /*
       * spawn 失败的回滚策略（与 PTY 一致）：
       * - 新建的 pane：回滚删除；
       * - 重启恢复的 pane：保留条目并回到停止态。
       */
      if (this.revivingPanes.has(paneId)) {
        this.revivingPanes.delete(paneId);
        this.session.setPaneRunning(paneId, false);
      } else {
        this.session.closePane(paneId);
      }
      this.pushError(
        result.reason === 'not-found' ? 'error.commandNotFound' : 'error.spawnFailed',
        { command: 'dsh web', reason: result.error },
        { paneId, projectId: pane.projectId },
      );
      this.pushSnapshot();
    });
  }

  /**
   * 在运行时向共享 dsh web 进程注册某 pane 的项目 workspace。
   *
   * dsh web 是全 app 共享的单进程，`HERDR_DESKTOP_CWD`/`HERDR_DESKTOP_PANE_ID`
   * 只在首次 spawn 时注入；第二个及后续项目复用已运行进程，拿不到自己的 env。
   * 这里通过 dsh 侧插件暴露的本地回环路由补注册（幂等，插件内 create 已存在则复用）。
   * 注册失败不阻断 pane 启动：旧版插件没有该路由时退化为原有行为。
   *
   * @param mode `create` 新建会话；`restore` 恢复该 pane 上次的会话（返回 null，不覆盖 partition）。
   * @returns 新建模式下的落地会话 id；恢复模式下通常为 null（让 partition 的 localStorage 生效），
   *          但空项目会新建并返回一个空白会话 id。
   */
  private async registerDshWorkspace(
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
   * 通知 dsh 插件移除某个已关闭 web pane 的广播条目（best-effort）。
   *
   * 插件据此把 paneId 从 cwd 的 Set 里移除，Set 清空后连 cwd 状态一起回收，
   * 避免共享 dsh 进程长期运行下映射无界增长。dsh 进程已死时回环调用失败会被吞掉。
   */
  private unregisterDshWorkspace(port: number, cwd: string, paneId: string): void {
    void fetch(`http://127.0.0.1:${port}/herdr-desktop/register-workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, paneId, mode: 'unregister' }),
    }).catch(() => {
      // 进程已退出或路由未注册时忽略。
    });
  }

  /** 尝试恢复一个停止态的 web pane（只改状态，不推送快照）。 */
  private tryReviveWeb(paneId: string, force = false): boolean {
    const pane = this.session.getPane(paneId);
    if (!pane || pane.kind !== 'web') return false;
    if (!force && (pane.running || this.web.has(paneId))) return false;

    this.revivingPanes.add(paneId);
    this.session.setPaneRunning(paneId, true);
    this.startWebAgent(paneId);
    return true;
  }

  /** 共享 web 进程意外退出（崩溃等）：收掉所有正在使用它的 pane。 */
  private onWebExit(paneIds: string[], _exitCode: number): void {
    for (const paneId of paneIds) {
      this.closePane(paneId);
    }
  }

  /**
   * 记录官方集成上报的会话引用与状态（对应 herdr 的
   * `handle_pane_report_agent_session` + `HookStateReported`）。
   *
   * 由 ReportServer（终端 hook 的 HTTP 上报）进入；
   * 来源与会话值经 agent-resume 校验，非官方来源直接忽略。
   * 上报后立即落盘，保证重启后仍可恢复；状态上报标记 hook 权威。
   */
  private reportAgentSession(
    paneId: string,
    report: {
      source: string;
      agent: string;
      sessionId?: string | null;
      sessionPath?: string | null;
      state?: 'working' | 'blocked' | 'idle' | 'done' | null;
      seq?: number | null;
      message?: string | null;
      sessionStartSource?: string | null;
      /** 切换绑定后的状态重放：只刷新状态，不触发声音/toast。 */
      replay?: boolean;
      /** idle 时的结束原因：aborted（手动停止）→ 直接 idle，不投影 done、不响完成声音。 */
      completion?: 'completed' | 'aborted';
      /** 工具完成心跳：只刷新 working，不得把已完成的 pane 拉回 working。 */
      heartbeat?: boolean;
    },
  ): void {
    const ref = agentResume.sessionRefFromReport(
      report.source,
      report.agent,
      report.sessionId ?? null,
      report.sessionPath ?? null,
    );
    // dsh 的 per-session 报告：用 sessionId 反查绑定，精确路由到正在看该会话的 pane；
    // 无绑定时回退到报告自带的 paneId（插件按 cwd 广播的兜底）。
    // 仅对 dsh 来源做绑定反查，避免其它 agent 的 sessionId 恰巧碰撞被误路由。
    const bound =
      report.source === 'herdr:dsh' && report.sessionId
        ? [...(this.dshSessionBinding.get(report.sessionId) ?? [])]
        : [];
    const targets = bound.length > 0 ? bound : [paneId];

    for (const targetPaneId of targets) {
      const terminal = this.session.getTerminal(targetPaneId);
      if (!terminal) continue;

      if (report.state && report.state !== 'done') {
        /*
         * 上报边界：屏幕上正显示权限/信任对话框时，丢弃 hook 报来的 working。
         *
         * herdr 的状态仲裁要求「屏幕观测新于 hook 上报」才允许 blocker 覆盖，
         * 所以一条比 blocker 更新的 working 会把 blocked 顶掉，屏幕下一次刷新再判回
         * blocked——一次权限提示被拆成成串跳变，通知又被冷却吃掉一半，表现为
         * 「阻塞一次响一次不响」（实测日志：两次 blocked 相隔 7~9 秒）。
         *
         * 在边界丢弃而不是削弱仲裁，是为了保持与 herdr 的仲裁逻辑一致。
         * 只丢 working：blocked/idle 必须照常放行（idle 是完成信号）。
         */
        if (report.state === 'working' && terminal.screenVisibleBlocker()) {
          continue;
        }
        /*
         * 心跳不得把已完成的 pane 拉回 working。
         *
         * 工具完成心跳（claude 的 PostToolUse）走 async，Stop 是同步的；模型在本轮末尾
         * 只回一两句话时 idle 会先落地，随后迟到的心跳以更大的 seq 把状态顶回 working，
         * 于是完成通知在投递前复核时被判成「证据不成立」而丢掉（提示音丢失），TTL 过期
         * 后又会再投影一次 done（重复徽标）。这里直接丢弃这种迟到心跳。
         */
        if (terminal.isStaleHeartbeat(report.state, report.heartbeat)) {
          continue;
        }
        /*
         * seq 兜底：hook 脚本未必能给出可移植的单调序号。
         *
         * macOS 的 BSD date 不支持 %3N，旧版脚本（集成 v5）会退化成恒发 "seq":0；
         * 而状态机要求 seq 严格递增（`seq <= last` 即丢弃），于是 PreInvocation 的
         * working 能进、Stop 的 idle 全被丢——表现为完成时没有提示音。
         *
         * 0 与负数都不是合法序号（正常来源是毫秒时间戳量级），一律当作「未提供」重新
         * 赋值。这样即便用户装的是旧脚本、没重装集成，也能恢复正常。
         *
         * 脚本自己给了合法 seq 就照用（antigravity 的 .ps1 会发毫秒时间戳，用于丢弃
         * 乱序投递的旧上报）；没给则问 TerminalState 要一个严格递增的——不能直接用
         * `Date.now()`：同一毫秒内的两条上报会撞号，后一条被水位丢掉（若丢的是 Stop
         * 的 idle，完成提示音就再也不会响）。
         */
        const reportedSeq = typeof report.seq === 'number' && report.seq > 0 ? report.seq : null;
        const seq = reportedSeq ?? terminal.nextHookReportSeq();
        const mutation = terminal.setHookAuthorityAt(
          report.source,
          report.agent,
          report.state,
          report.message ?? null,
          ref,
          seq,
          Date.now(),
        );
        if (mutation) {
          // 手动停止（aborted）：suppress 完成——不投影 done、不记录完成、不响完成声音。
          const aborted = report.completion === 'aborted';
          const transition = this.session.applyStateChange(targetPaneId, mutation, aborted);
          // 重放与手动停止都只刷新状态，不触发声音/toast。
          if (!report.replay && !aborted) {
            this.notifyForTransition(targetPaneId, mutation, transition, report.message ?? undefined);
          }
          // working 上报会过期（见 scheduleHookWorkingExpiry），需要有人在到期时重新评估
          if (report.state === 'working') {
            this.scheduleHookWorkingExpiry(targetPaneId);
          } else {
            this.cancelHookWorkingExpiry(targetPaneId);
          }
        }
      } else if (ref) {
        // 仅会话上报（对应 herdr handle_pane_report_agent_session → AgentSessionReported）。
        terminal.setAgentSessionRefForSessionStart(
          report.source,
          report.agent,
          ref,
          /*
           * 刻意**不**补 seq（与状态上报不同）：opencode 的 select 靠 `seq === null` 走
           * 「未排序选择」那条专门分支（isUnsequencedOpencodeSelection），补了 seq 就会
           * 破坏它的重绑语义。
           *
           * 脚本不带 seq 时被 seq 水位挡住的问题，改在 terminal-state 里按「是否真的在
           * 切换会话」窄口径放行（见 setAgentSessionRefForSessionStart 的 switchesSession）。
           */
          report.seq ?? null,
          report.sessionStartSource ?? null,
          Date.now(),
        );
      }
    }

    this.pushSnapshot();
  }

  /**
   * 记录 dsh web pane 当前正在查看的会话（由渲染端 WebPane 轮询上报）。
   * 一个 pane 只绑定一个会话；一个会话可被多个 pane 同时查看。
   */
  private bindDshSession(paneId: string, sessionId: string | null): void {
    for (const set of this.dshSessionBinding.values()) {
      set.delete(paneId);
    }
    if (sessionId) {
      let set = this.dshSessionBinding.get(sessionId);
      if (!set) {
        set = new Set();
        this.dshSessionBinding.set(sessionId, set);
      }
      set.add(paneId);
      // 切换绑定后请求插件立即重发该会话的当前状态，让 pane 刷新，
      // 而不是停留在旧会话的最后一次状态（seq 由插件管理，保持单调）。
      this.requestDshSessionReplay(paneId, sessionId);
    }
  }

  /**
   * 请求 dsh 插件立即重发某个会话的当前状态（best-effort）。
   * 插件用自身单调递增的 seq 上报，main 按绑定路由到该 pane。
   */
  private requestDshSessionReplay(paneId: string, sessionId: string): void {
    const pane = this.session.getPane(paneId);
    if (!pane || pane.kind !== 'web' || !pane.port) return;
    // 带上 paneId：插件 replay 时若该 pane 尚未通过 register 注册进广播表，
    // 也能临时补注册，确保重发的状态能路由回请求方 pane（消除重启时的竞态）。
    void fetch(`http://127.0.0.1:${pane.port}/herdr-desktop/register-workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'replay', sessionId, paneId }),
    }).catch(() => {
      // 插件旧版本无 replay 模式时忽略。
    });
  }

  /**
   * 重启一个 pane（侧栏「重新启动」按钮入口）。
   *
   * 复用两阶段创建的机制：先把参数放回 pendingSpawns 并标记 running，
   * 渲染端随后挂载终端 → fit → 上报尺寸 → attach-pane，
   * 此时 attachPane 读取暂存的参数与尺寸拉起 PTY，首帧排版即正确。
   *
   * `force` 用于运行中的 pane：先杀掉现有进程再按同样流程拉起。
   * 这**会**丢弃该 agent 的当前会话与滚动缓冲，因此调用方必须已经
   * 向用户确认过（见 AgentRow 的确认框）——这里不再二次确认。
   */
  private respawnPane(paneId: string, force: boolean): void {
    const pane = this.session.getPane(paneId);
    if (!pane) return;

    /*
     * 恢复参数必须在 killForRestart 之前算出来。
     *
     * killForRestart 会调 clearAgentRuntimeIdentityAfterRespawn()，把 hookAuthority
     * 与 persistedAgentSession 一起清掉，而 resumeParamsFor 正是从 TerminalState 读
     * 会话引用（currentSessionForPersistence）。清完再算只能拿到 null，重启就退化成
     * 「重放原始 command/args」，表现为重启后没有恢复会话。
     *
     * 对应 herdr 的 restore_plan_for_snapshot：恢复计划取自持久化快照，且在重建运行时
     * 身份之前就定下来（herdr 存进 pending_agent_resume_plan，port 这里直接透传）。
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
        ? this.tryReviveWeb(paneId, force)
        : this.tryRevive(paneId, force, resume);
    if (revived) {
      /*
       * 顺序要紧：先让 tryRevive 把参数写进 pendingSpawns，再递增 restartSeq。
       * 渲染端收到递增后的快照会重建终端，随后的 attachPane 才能取到参数；
       * 反过来推的话，重建发生在参数入队之前，attachPane 会空手而归。
       */
      if (force) {
        this.session.bumpPaneRestart(paneId);
      }
      this.pushSnapshot();
    }
  }

  /**
   * 杀掉 pane 的现有进程，为「运行中重启」做准备。
   *
   * 只做 kill，不碰 session 状态——由调用方紧接着走 revive 路径重新拉起。
   * 必须先 kill 再 revive：tryRevive 会检查 `pty.has()` / `web.has()`，
   * 残留的运行时会让它判定「已在运行」而直接返回。
   *
   * web pane 是例外：`dsh web` 全 app 只有一个共享进程，结束它就等于把**所有**
   * web pane 的服务端一起重启（其余 pane 正在跑的会话会一并丢失），因此这里只
   * 解除该 pane 的引用、不动进程（随后 acquire 会把它重新计入使用方）。
   * 单 pane 的重启因此落在渲染端：由 respawnPane 递增 restartSeq 触发
   * `<webview>` 重建，用同一个认证链接重新加载页面（见 WebPane）。
   */
  private killForRestart(paneId: string, isWeb: boolean): void {
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
       *
       * 这也兑现了 respawnPane 的约定——强制重启丢弃当前会话与滚动缓冲。
       */
      this.broadcast({ type: IPC.PTY_RESET, payload: { paneId } });
    }
    // 两阶段创建的中间态一并清掉，避免旧参数被 attachPane 复用
    this.pendingSpawns.delete(paneId);
    this.pendingSizes.delete(paneId);
    this.revivingPanes.delete(paneId);
    // 运行中强制重启：重置 agent 运行时身份（对应 herdr clear_agent_runtime_identity_after_respawn）
    this.session.getTerminal(paneId)?.clearAgentRuntimeIdentityAfterRespawn();
  }

  /**
   * 尝试恢复一个停止态 pane（只改状态，不推送快照）。
   *
   * 返回是否触发了恢复；调用方决定何时推送快照。
   * 已在运行 / 已在等待启动 / 无启动命令（旧格式）时为 no-op——
   * 除非 `force`（运行中重启），此时这些检查已被 killForRestart 处理过。
   *
   * `resume` 是调用方预先算好的恢复参数：`undefined` 表示「这里现算」，
   * `null` 表示「已算过、没有可用计划」。运行中重启必须走后者——那时
   * TerminalState 已被 killForRestart 清空，回读只会得到 null。
   */
  private tryRevive(
    paneId: string,
    force = false,
    resume?: SpawnAgentParams | null,
  ): boolean {
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
    this.revivingPanes.add(paneId);
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
  private resumeParamsFor(pane: PaneState): SpawnAgentParams | null {
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

  /**
   * 第二阶段：终端已就绪，用精确尺寸启动 PTY。
   */
  private attachPane(paneId: string): void {
    const params = this.pendingSpawns.get(paneId);
    if (!params) return;
    this.pendingSpawns.delete(paneId);

    const pane = this.session.getPane(paneId);
    if (!pane) return;

    // 用终端上报的精确尺寸启动；没有则回退到默认值
    const size = this.pendingSizes.get(paneId);
    this.pendingSizes.delete(paneId);

    const env = this.launchEnvFor(params.command);
    this.injectHookEnv(env, paneId, params.command);
    const result = this.pty.spawn(paneId, params, env, pane.cwd ?? undefined, size);

    if (!result.ok) {
      /*
       * spawn 失败的回滚策略：
       * - 新建的 pane：回滚删除（和今天的行为一致）；
       * - 重启恢复的 pane：**保留**条目并回到停止态——
       *   命令被卸载等原因导致的一次失败不应连带丢掉用户的会话结构。
       */
      if (this.revivingPanes.has(paneId)) {
        this.revivingPanes.delete(paneId);
        this.session.setPaneRunning(paneId, false);
      } else {
        this.session.closePane(paneId);
      }
      this.pushError(
        result.reason === 'not-found' ? 'error.commandNotFound' : 'error.spawnFailed',
        { command: params.command, reason: result.error },
        { paneId, projectId: params.projectId },
      );
      this.pushSnapshot();
      return;
    }

    this.revivingPanes.delete(paneId);

    /*
     * 进程检测等价物（对应 herdr 的 set_detected_agent_process_at）：
     * desktop 没有独立的进程名检测，这里用启动命令首 token 识别 agent，
     * 使 full-lifecycle hook 权威（如 opencode）能在 TUI 不打印 agent 名时仍生效。
     */
    const terminal = this.session.getTerminal(paneId);
    if (terminal) {
      const commandName = params.command.trim().split(/\s+/)[0];
      const detectedAgent = parseAgentLabel(commandName);
      if (detectedAgent) {
        terminal.setDetectedAgentProcessAt(detectedAgent, Date.now());
      }
    }

    /*
     * 工作目录失效时 pane 仍会启动（回退到主目录），但用户需要知道
     * 「agent 不在我以为的那个目录里」——否则会在错误的目录里改文件。
     * 不当作错误处理：agent 已经正常跑起来了。
     */
    if (result.cwdFallback) {
      this.pushError(
        'error.cwdNotFound',
        { path: result.cwdFallback.requested, used: result.cwdFallback.used },
        { paneId, projectId: params.projectId },
      );
    }

    this.pushSnapshot();
  }

  /**
   * 组装启动 agent 子进程的环境变量。
   *
   * 在平台基础环境之上，按设置注入代理：
   * - 代理地址已配置，且该命令在 proxyAgents 中被开启时，
   *   注入 HTTP_PROXY / HTTPS_PROXY（大小写各一份，覆盖不同工具的读取习惯）
   *   与 ALL_PROXY，并把本地回环地址排除在代理之外（NO_PROXY）。
   * - 其余情况（未配置地址 / 该命令未开启）返回基础环境，行为与之前完全一致。
   *
   * 注入发生在进程启动时——运行中的 agent 不受后续设置变更影响，
   * 需要生效时重启该 agent。
   */
  private launchEnvFor(command: string): Record<string, string> {
    const env = resolveLaunchEnv().env;
    const settings = this.settings.get();
    const proxyUrl = settings.proxyUrl.trim();
    if (!proxyUrl || settings.proxyAgents[command] !== true) {
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
   * 官方集成 hook 脚本据此知道自己的 pane、agent 和上报地址：
   * - HERDR_DESKTOP_PANE_ID：pane 标识；
   * - HERDR_DESKTOP_AGENT：agent 命令首 token（用于构造 source `herdr:<agent>`）；
   * - HERDR_DESKTOP_REPORT_URL：本地上报端点（含一次性 token）。
   */
  private injectHookEnv(env: Record<string, string>, paneId: string, command: string): void {
    const reportUrl = this.reportServer.reportUrl;
    if (!reportUrl) return;
    env.HERDR_DESKTOP_PANE_ID = paneId;
    env.HERDR_DESKTOP_AGENT = command.trim().split(/\s+/)[0];
    env.HERDR_DESKTOP_REPORT_URL = reportUrl;
  }

  /**
   * 推送一条用户可见的错误。
   *
   * 只传文案 key 与插值变量，本地化由 Renderer 完成，
   * 保证语言切换后历史消息不会停留在旧语言。
   */
  private pushError(
    titleKey: string,
    titleVars?: Record<string, string | number>,
    extra?: { messageKey?: string; paneId?: string; projectId?: string },
  ): void {
    this.broadcast({
      type: 'app:error',
      payload: {
        titleKey,
        titleVars,
        detailKey: extra?.messageKey,
        paneId: extra?.paneId,
        projectId: extra?.projectId,
      },
    });
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
  private detectionPath(): string {
    if (this.detectionPathCache === null) {
      try {
        const { env } = resolveLaunchEnv();
        this.detectionPathCache = env.PATH ?? env.Path ?? '';
      } catch {
        this.detectionPathCache = process.env.PATH ?? '';
      }
    }
    return this.detectionPathCache;
  }

  /** 探测本机 agent 命令可用性。 */
  probeAgentAvailability(commands: string[]): Record<string, boolean> {
    const pathValue = this.detectionPath();
    const available: Record<string, boolean> = {};
    for (const command of commands) {
      const name = command.trim().split(/\s+/)[0] ?? command;
      available[command] = isCommandAvailable(name, pathValue);
    }
    return available;
  }

  /**
   * 关闭/退出一个 pane 后，若焦点被转移到停止态 pane，把它也拉起。
   *
   * 场景：终端里 Ctrl+C 退出聚焦的 agent → onExit → session.closePane 把焦点
   * 转移到同项目第一个 pane（可能是恢复出的停止态）。渲染层不参与这条路径，
   * 不会像侧栏关闭那样先 focusSurvivorBeforeClose 恢复幸存者，因此这里补一次。
   */
  private reviveFocusedPaneIfStopped(): void {
    const focusedPaneId = this.session.snapshot().focusedPaneId;
    if (!focusedPaneId) return;
    const pane = this.session.getPane(focusedPaneId);
    if (!pane) return;
    if (pane.kind === 'web') {
      this.tryReviveWeb(focusedPaneId);
    } else {
      this.tryRevive(focusedPaneId);
    }
  }

  private closePane(paneId: string): void {
    // 关闭 web pane 时，通知 dsh 插件把这个 paneId 从广播表里移除，避免映射无界增长。
    const closing = this.session.getPane(paneId);
    if (closing?.kind === 'web' && closing.cwd && closing.port) {
      this.unregisterDshWorkspace(closing.port, closing.cwd, paneId);
    }
    // 清理该 pane 的会话绑定。
    this.bindDshSession(paneId, null);
    this.pty.kill(paneId);
    this.web.release(paneId);
    // 清理两阶段创建的中间态，避免 pending 泄漏
    this.pendingSpawns.delete(paneId);
    this.pendingSizes.delete(paneId);
    this.revivingPanes.delete(paneId);
    this.session.closePane(paneId);
    this.reviveFocusedPaneIfStopped();
    this.pushSnapshot();
  }

  private focusPane(paneId: string): void {    // 聚焦即「已看」：Session.focusPane 会置 seen=true，done 投影自动回落 idle。
    this.session.focusPane(paneId);
    /*
     * 选中即恢复：聚焦的 pane 处于停止态时自动拉起进程。
     *
     * 必须与 focusPane 合并在**同一次**快照里推送——若分两次推，
     * 渲染端会先收到「已聚焦但未运行」的中间态，
     * 「重新启动」提示会闪现一帧才被终端替换。
     */
    const pane = this.session.getPane(paneId);
    if (pane?.kind === 'web') {
      this.tryReviveWeb(paneId);
    } else {
      this.tryRevive(paneId);
    }
    this.pushSnapshot();
  }

  /**
   * 该 agent 的「完成」是否由集成 hook 负责。
   *
   * 只有集成**确实装着**才把完成判定交给 hook：
   * - 装了：屏幕的 working/blocked → idle 不再发通知，避免「初始化完成 / 工具跑完」误响；
   *   完成改由 hook 的 idle 上报驱动（antigravity 用 Stop + fullyIdle）。
   * - 没装（或版本过旧）：hook 永远不会上报 idle，若仍抑制屏幕，该 agent 就再也不会
   *   响完成提示音。此时保持原行为，由屏幕决定。
   *
   * 注意只认 `installed`，不认 `outdated`：旧版本集成未必会上报状态（antigravity v3
   * 只报会话身份），按 outdated 放行会让用户升级前一直误响，按 not-installed 处理更安全。
   */
  private agentCompletionFromHooks(agent: string | null): boolean {
    if (!agent || !screenCompletionIgnored(agent)) return false;
    const cached = this.hookCompletionCache.get(agent);
    if (cached !== undefined) return cached;
    const installed = hookStatuses()[agent] === 'installed';
    this.hookCompletionCache.set(agent, installed);
    return installed;
  }

  private refreshAgent(paneId: string): void {
    const snapshot = this.pty.snapshot(paneId);
    const pane = this.session.getPane(paneId);
    const terminal = this.session.getTerminal(paneId);
    if (!terminal) return;

    // 终端检测不到 agent 名时回退到启动命令首 token（如 opencode 的 TUI 底部不出现名字）
    const fallbackAgent = pane?.command?.trim().split(/\s+/)[0] ?? null;
    const result = detectFromSnapshot(snapshot, fallbackAgent);

    // 展示字段（name/title）单独更新；状态一律经 TerminalState 仲裁后在 snapshot 投影
    this.session.updateAgentPresentation(paneId, result.name, result.title);

    /*
     * skip_state_update：命中的规则明确要求「不要拿这次观测改状态」。
     *
     * 对应 herdr 的 `(!detection.skip_state_update).then_some(detection)`——那边是整条
     * 检测结果被丢弃、状态保持原样。典型场景：claude 打开 /model 选择器或详细记录
     * 视图时，屏幕上不再有 spinner/prompt box 特征，若照常按 fallback 判成 idle，
     * 就会产生一次 working → idle 的假完成跳变（误响提示音）。
     *
     * 注意 name/title 仍然更新：这些规则只否决「状态」，不影响侧栏展示的标题。
     */
    if (result.skipStateUpdate) return;

    // 状态仲裁（对应 herdr set_detected_state_with_screen_signals_at）。
    // agent 参数用命令派生的 detectedAgent（进程检测等价物），屏幕只提供 fallback 状态；
    // 不能用 result.detectedName——那会因 TUI 不打印 agent 名而把 detectedAgent 清空。
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
     * 完成判定交给 hook 的 agent（见 screenCompletionIgnored），屏幕观测不产生「完成」：
     * 既不发通知，也不在投影层置 done / 写 completionSeq。
     *
     * 原因：屏幕分不清「初始化完成 / 工具跑完 / 会话真的结束」，三者都表现为 spinner
     * 停下，都会产生 working/blocked → 完成 的跳变。
     *
     * 只掐掉通知（历史实现）会留下另一半后果：pane 依然被记成「未看完成」——
     * 后台 pane 的侧栏圆点变成绿色 done，要等用户聚焦回来才回落 idle。所以这里把
     * 同一条判据也传给 applyStateChange（forceSuppressCompletion），让投影层连
     * seen / completionSeq 一起不更新。
     *
     * 两个前提缺一不可：
     * 1. 该 agent 的集成**确实装了**（agentCompletionFromHooks）——没装时 hook 永远不会
     *    上报 idle，若仍然抑制屏幕，它就此再也不会响完成提示音、也再不会出现 done 徽标；
     * 2. 命中的是**原始状态**的完成跳变（mutation 里的 working/blocked → idle），
     *    不是投影后的 AgentStatus。
     */
    const hooksOwnCompletion =
      this.agentCompletionFromHooks(terminal.detectedAgent) || terminal.hookStateAuthorityActive();
    const screenChange = mutation.effectiveStateChange;
    const screenCompletion =
      screenChange !== null &&
      isCompletionTransition(screenChange.previousState, screenChange.state);
    const transition = this.session.applyStateChange(
      paneId,
      mutation,
      screenCompletion && hooksOwnCompletion,
    );
    /*
     * 投影后的跳变仍用于通知判定：transition.to 是 **AgentStatus**
     * （idle | done | working | blocked），paneAgentStatus 会把「未聚焦 pane 的完成」
     * 投影成 `done`（见 session.ts），所以必须同时匹配 idle 与 done，否则只有聚焦的
     * pane 被抑制、后台 pane 照旧乱响。
     */
    const screenSaysDone =
      transition !== null &&
      (transition.to === 'idle' || transition.to === 'done') &&
      (transition.from === 'working' || transition.from === 'blocked');
    if (!(screenSaysDone && hooksOwnCompletion)) {
      this.notifyForTransition(paneId, mutation, transition);
    }

    /*
     * 采集端 fallback：从终端输出识别出会话 id 时，把它持久化到 terminal，
     * 之后重启该 pane 就能带 `--resume`/`--session` 恢复。
     * 权威来源仍是 hook 上报（agent:report-session）；这里只做兜底，
     * 且经 sessionRefFromReport 校验官方来源，非白名单 agent 直接忽略。
     */
    if (result.detectedName && result.sessionId) {
      const source = `herdr:${result.detectedName}`;
      const ref = agentResume.sessionRefFromReport(
        source,
        result.detectedName,
        result.sessionId,
        null,
      );
      if (ref) {
        this.session.setPaneAgentSession(paneId, {
          source,
          agent: result.detectedName,
          kind: ref.kind,
          value: ref.value,
        });
      }
    }

    this.pushSnapshot();
  }

  /**
   * 根据状态跳变决定通知：
   * - blocked → 通知 blocked；
   * - 完成跳变（working/blocked → idle）→ 通知 done，**无论前台后台**——声音应始终
   *   提示，toast 由渲染端按「该 pane 是否前台」决定是否展示。
   */
  private notifyForTransition(
    paneId: string,
    mutation: TerminalStateMutation,
    transition: { from: string; to: string } | null,
    message?: string,
  ): void {
    if (!transition) return;
    if (transition.to === 'blocked') {
      this.notifyAgentStatus(paneId, 'blocked', message);
      return;
    }
    const change = mutation.effectiveStateChange;
    const completed =
      change !== null && isCompletionTransition(change.previousState, change.state);
    if (completed || transition.to === 'done') {
      this.notifyAgentStatus(paneId, 'done', message);
    }
  }

  /**
   * agent 状态变化通知 —— 入队（对应 herdr `receive_notification`）。
   *
   * 不再用时间冷却去重，而是采用 herdr 的两条规则：
   *
   * 1. **同 pane 替换**：新通知到达时丢掉该 pane 已排队/待投递的通知
   *    （herdr 用 `retain` 做同样的事）。屏幕检测抖动产生的一串跳变因此合并成一条。
   * 2. **投递前校验**：延后 `NOTIFY_DELIVERY_DELAY_MS` 投递，投递时按**当时**的 pane
   *    状态复核——`blocked` 要求仍是 blocked，`done` 要求仍是 idle；仍在变化就每
   *    50ms 重试，超过 `NOTIFY_EVIDENCE_GRACE_MS` 宽限期则丢弃。
   *    假完成（工具跑完、菜单开关那种瞬时跳变）在这 1 秒里就消失了，不发声。
   */
  /**
   * 安排一次「working 过期后重新评估」。
   *
   * 状态机只在有观测时才重算（PTY 数据 / hook 上报）。用户按 Esc 取消后 TUI 静止，
   * 不会再有观测，TTL 就永远不会被求值。这里在到期后主动跑一次屏幕检测，
   * 使过期的 working 失效、状态按当前屏幕回落。
   *
   * 重复上报会重置定时器（每次 working 都刷新 TTL）。
   */
  private scheduleHookWorkingExpiry(paneId: string): void {
    /*
     * 只对真有 PTY 的 pane 安排：web pane 没有终端输出，refreshAgent 会拿空快照
     * 去做屏幕检测，反而把 dsh 的状态改坏。
     */
    if (!this.pty.has(paneId)) return;
    this.cancelHookWorkingExpiry(paneId);
    const timer = setTimeout(() => {
      this.hookWorkingExpiry.delete(paneId);
      // 重新跑一次屏幕检测；此时 hook 的 working 已过期，状态会按屏幕判定
      this.refreshAgent(paneId);
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

  private notifyAgentStatus(paneId: string, status: 'blocked' | 'done', message?: string): void {
    const now = Date.now();
    // 同 pane 替换：该 pane 之前排队的通知一律作废（只保留最新状态）
    this.pendingNotifies = this.pendingNotifies.filter((item) => item.paneId !== paneId);
    this.pendingNotifies.push({
      paneId,
      status,
      message,
      deliverAt: now + NOTIFY_DELIVERY_DELAY_MS,
      expiresAt: now + NOTIFY_DELIVERY_DELAY_MS + NOTIFY_EVIDENCE_GRACE_MS,
    });
    this.ensureNotifyTicker();
  }

  /** 启动通知轮询（队列空时自动停，避免空转）。 */
  private ensureNotifyTicker(): void {
    if (this.notifyTicker) return;
    this.notifyTicker = setInterval(() => this.tickNotifies(), NOTIFY_TICK_MS);
    // 只有通知任务时不该拖住进程退出
    this.notifyTicker.unref?.();
  }

  private stopNotifyTicker(): void {
    if (!this.notifyTicker) return;
    clearInterval(this.notifyTicker);
    this.notifyTicker = null;
  }

  /** 推进通知队列（对应 herdr `tick_notifications`）。 */
  private tickNotifies(): void {
    const now = Date.now();
    const kept: PendingNotify[] = [];
    for (const item of this.pendingNotifies) {
      if (item.deliverAt > now) {
        kept.push(item);
        continue;
      }
      const state = this.session.detectedStateFor(item.paneId);
      if (state === null) continue; // pane 已关闭
      const expected = item.status === 'blocked' ? 'blocked' : 'idle';
      if (state !== expected) {
        /*
         * 证据不成立。若状态刚刚还在变化（尚未超过宽限期），稍后重试——屏幕检测的
         * 解析是分片异步的，状态可能还在落定；超过宽限期就判定为抖动丢弃。
         */
        if (now < item.expiresAt) {
          kept.push({ ...item, deliverAt: now + NOTIFY_TICK_MS });
        }
        continue;
      }
      this.deliverNotify(item);
    }
    this.pendingNotifies = kept;
    if (this.pendingNotifies.length === 0) this.stopNotifyTicker();
  }

  /** 真正把通知推给渲染进程（声音 / toast 由渲染端决定）。 */
  private deliverNotify(item: PendingNotify): void {
    const pane = this.session.getPane(item.paneId);
    if (!pane) return;
    this.broadcast({
      type: IPC.AGENT_STATUS,
      payload: {
        paneId: item.paneId,
        projectId: pane.projectId,
        label: pane.label ?? item.paneId,
        status: item.status,
        ...(item.message ? { message: item.message } : {}),
      },
    });
  }

  private broadcast(msg: MainToRendererMessage): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(msg.type, msg);
    }
  }

  private pushSettings(settings: ReturnType<SettingsStore['get']>): void {
    this.broadcast({
      type: IPC.STATE_SETTINGS,
      version: 1,
      payload: settings,
    });
  }

  private pushSnapshot(): void {
    const snapshot = this.session.snapshot();
    this.broadcast({
      type: IPC.STATE_SNAPSHOT,
      version: 1,
      payload: snapshot,
    });
    void saveState(snapshot);
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
