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
import { PtyManager } from '../runtime/pty-manager';
import { WebAgentManager } from '../runtime/web-agent-manager';
import { SettingsStore } from '../runtime/settings';
import { detectFromSnapshot } from '../runtime/agent-detector';
import { detectGitBranch } from '../runtime/git';
import { saveState, loadState, flushState } from '../runtime/persist';
import { resolveLaunchEnv, isCommandAvailable } from '../platform';
import { IPC } from './protocol';
import type { MainToRendererMessage, ProxyTestResult } from '../../shared/protocol';
import type {
  AddProjectParams,
  SpawnAgentParams,
  SpawnWebAgentParams,
  ThemePreference,
  Language,
} from '../../shared/state';

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

  /**
   * 标题栏配色回调，由主进程在创建窗口后注入。
   *
   * 原生 titleBarOverlay 的颜色不受渲染侧 CSS 控制，需要显式同步。
   */
  onTitleBarTheme?: (color: string, symbolColor: string) => void;

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
        this.broadcast({
          type: IPC.PTY_EXIT,
          payload: { paneId, exitCode, signal: signal ?? null },
        });
        this.pushSnapshot();
      },
    });

    this.web = new WebAgentManager({
      onExit: (paneId, exitCode) => this.onWebExit(paneId, exitCode),
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
    ipcMain.on(IPC.RESPAWN_PANE, (_event, payload: { paneId: string }) => {
      this.respawnPane(payload.paneId);
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
        .then((settings) => this.pushSettings(settings));
    });
    ipcMain.on(IPC.SET_FONT_SIZE, (_event, payload: { fontSize: number }) => {
      void this.settings
        .setFontSize(payload.fontSize)
        .then((settings) => this.pushSettings(settings));
    });
    ipcMain.on(IPC.SET_SIDEBAR, (_event, payload: { collapsed: boolean }) => {
      void this.settings
        .setSidebarCollapsed(payload.collapsed)
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
    ipcMain.on(IPC.NAMED, (_event, payload: { kind: string; data: string }) => {
      this.handleNamed(payload);
    });

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

  private handleNamed(payload: { kind: string; data: string }): void {
    try {
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
      this.web.kill(paneId);
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

    const env = this.launchEnvFor('dsh');
    void this.web.spawn(paneId, env, pane.cwd ?? undefined).then((result) => {
      if (result.ok) {
        this.revivingPanes.delete(paneId);
        this.session.setPaneWebUrl(paneId, result.cleanUrl);
        this.broadcast({
          type: IPC.WEB_READY,
          payload: { paneId, url: result.url },
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

  /** 尝试恢复一个停止态的 web pane（只改状态，不推送快照）。 */
  private tryReviveWeb(paneId: string): boolean {
    const pane = this.session.getPane(paneId);
    if (!pane || pane.kind !== 'web') return false;
    if (pane.running || this.web.has(paneId)) return false;

    this.revivingPanes.add(paneId);
    this.session.setPaneRunning(paneId, true);
    this.startWebAgent(paneId);
    return true;
  }

  /** web 子进程意外退出（崩溃等）：按与 PTY 退出一致的方式收掉 pane。 */
  private onWebExit(paneId: string, _exitCode: number): void {
    this.web.kill(paneId);
    this.session.closePane(paneId);
    this.pushSnapshot();
  }

  /**
   * 重启一个停止态 pane（「重新启动」按钮入口）。
   *
   * 复用两阶段创建的机制：先把参数放回 pendingSpawns 并标记 running，
   * 渲染端随后挂载终端 → fit → 上报尺寸 → attach-pane，
   * 此时 attachPane 读取暂存的参数与尺寸拉起 PTY，首帧排版即正确。
   */
  private respawnPane(paneId: string): void {
    const pane = this.session.getPane(paneId);
    const revived = pane?.kind === 'web' ? this.tryReviveWeb(paneId) : this.tryRevive(paneId);
    if (revived) {
      this.pushSnapshot();
    }
  }

  /**
   * 尝试恢复一个停止态 pane（只改状态，不推送快照）。
   *
   * 返回是否触发了恢复；调用方决定何时推送快照。
   * 已在运行 / 已在等待启动 / 无启动命令（旧格式）时为 no-op。
   */
  private tryRevive(paneId: string): boolean {
    const pane = this.session.getPane(paneId);
    if (!pane?.command) return false;
    if (pane.running || this.pty.has(paneId) || this.pendingSpawns.has(paneId)) return false;

    const params: SpawnAgentParams = {
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

  private closePane(paneId: string): void {
    this.pty.kill(paneId);
    this.web.kill(paneId);
    // 清理两阶段创建的中间态，避免 pending 泄漏
    this.pendingSpawns.delete(paneId);
    this.pendingSizes.delete(paneId);
    this.revivingPanes.delete(paneId);
    this.session.closePane(paneId);
    this.pushSnapshot();
  }

  private focusPane(paneId: string): void {
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

  private refreshAgent(paneId: string): void {
    const snapshot = this.pty.snapshot(paneId);
    const result = detectFromSnapshot(snapshot);
    const transition = this.session.updateAgent(paneId, result);
    if (transition && (transition.to === 'blocked' || transition.to === 'done')) {
      this.notifyAgentStatus(paneId, transition.to);
    }
    this.pushSnapshot();
  }

  /**
   * agent 状态变化通知。
   *
   * 转到 blocked / done 时推送一条 `agent:status` 给渲染端，
   * 由渲染端决定 toast 与系统通知；Main 只给结构化数据与文案 key，
   * 本地化仍留在渲染端。
   */
  private notifyAgentStatus(paneId: string, status: 'blocked' | 'done'): void {
    const pane = this.session.getPane(paneId);
    if (!pane) return;
    this.broadcast({
      type: IPC.AGENT_STATUS,
      payload: {
        paneId,
        projectId: pane.projectId,
        label: pane.label ?? paneId,
        status,
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
