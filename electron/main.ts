/**
 * Electron 主进程入口 —— 对应 herdr `src/main.rs` 的角色。
 *
 * 创建窗口、注册 IPC、管理 Agent 运行时生命周期。
 */

import { app, BrowserWindow, Menu, shell, ipcMain, nativeTheme } from 'electron';
import { join } from 'node:path';
import { IpcRouter } from './ipc/router';
import { validateManifestRegionsAtStartup } from '../shared/detect/facade';
import { IPC } from './ipc/channels';
import { readClipboard } from './support/clipboard';
import { logLine, flushLogSync } from './support/logger';
import { translate, type MessageKey } from '../shared/i18n';
import { SHORTCUTS, indexedAccelerator, type ShortcutActionId } from '../shared/shortcuts';

/**
 * 主题对应的窗口底色与原生标题栏按钮配色，需与 global.css 的 --bg-app 一致。
 *
 * 渲染进程首次绘制前会先露出窗口底色（backgroundColor），不一致会闪一下旧配色；
 * 浮动面板布局下 --bg-app 是"面板之间的缝隙色"，也是标题栏底色，因此这里同时
 * 决定原生窗口按钮条的颜色是否与标题栏齐平。
 */
const THEME_COLORS = {
  light: { background: '#fafafd', overlay: '#fafafd', symbol: '#3b3b3b' },
  dark: { background: '#0d0d0d', overlay: '#0d0d0d', symbol: '#cccccc' },
} as const;

type ResolvedTheme = keyof typeof THEME_COLORS;

/**
 * 把原生主题解析为实际主题。
 *
 * nativeTheme.themeSource 已在 IpcRouter.loadSettings() / 主题切换时按应用设置同步，
 * 因此 shouldUseDarkColors 就是「system 已解析为具体值」后的结果。
 */
function resolveNativeTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

const DEFAULT_WINDOW = { width: 1280, height: 800, minWidth: 720, minHeight: 480 };

/** 自绘标题栏高度，需与渲染侧 CSS 中的 --titlebar-height 保持一致。 */
const TITLEBAR_HEIGHT = 36;

/**
 * 应用图标路径。
 * Windows / Linux 的窗口图标需要显式指定（打包后 electron-builder 也会写入 exe）；
 * macOS 由 app bundle 的 .icns 决定，此处的值被忽略。
 */
const APP_ICON = join(__dirname, '../../build/icon.png');

/**
 * 标题栏叠加层配色：跟随应用主题，由渲染侧通过 IPC 更新。
 * 创建窗口时按当前主题初始化；弹窗打开时渲染侧会发送压暗后的近似色。
 */
let overlayColors: { color: string; symbolColor: string } = {
  color: THEME_COLORS.light.overlay,
  symbolColor: THEME_COLORS.light.symbol,
};

let router: IpcRouter;
/** 主窗口引用，供标题栏配色更新使用。 */
let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  const theme = resolveNativeTheme();
  overlayColors = {
    color: THEME_COLORS[theme].overlay,
    symbolColor: THEME_COLORS[theme].symbol,
  };

  const win = new BrowserWindow({
    ...DEFAULT_WINDOW,
    backgroundColor: THEME_COLORS[theme].background,
    show: false,
    title: 'Herdr',
    useContentSize: true,
    autoHideMenuBar: true,
    // macOS 忽略此项（用 bundle 的 .icns），Windows / Linux 生效
    ...(process.platform === 'darwin' ? {} : { icon: APP_ICON }),
    /*
     * 自绘标题栏：隐藏原生标题栏文字区域，但保留原生的最小化/最大化/关闭按钮
     * （titleBarOverlay）。渲染侧在顶部绘制拖拽区与主题切换。
     * macOS 使用 hiddenInset 保留交通灯按钮位置。
     */
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: overlayColors.color,
            symbolColor: overlayColors.symbolColor,
            height: TITLEBAR_HEIGHT,
          },
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // 允许渲染进程用 <webview> 内嵌 DeepSeek Harness Web GUI
      webviewTag: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../../dist/index.html'));
  }

  // 渲染进程就绪后推送初始快照
  win.webContents.on('did-finish-load', () => {
    router.pushSnapshotTo(win);
  });

  /*
   * 渲染层崩溃后窗口已无法交互，直接收掉它——关掉最后一个窗口即退出应用。
   * 崩溃原因由 web-contents-created 里的统一处理器落盘（覆盖所有 webContents），
   * 这里只负责收窗口，不再重复记日志。
   */
  win.webContents.on('render-process-gone', () => {
    win.close();
  });

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  return win;
}

/**
 * 更新标题栏叠加层配色，使其与当前主题一致。
 *
 * Windows 上 titleBarOverlay 的颜色是主进程持有的原生属性，
 * 无法用 CSS 控制，因此主题切换时需要显式同步。
 */
function setTitleBarOverlay(color: string, symbolColor: string): void {
  overlayColors = { color, symbolColor };
  if (!mainWindow || mainWindow.isDestroyed()) return;
  /*
   * 窗口底色独立于标题栏按钮条色更新：
   * 弹窗打开时按钮条会被渲染侧压暗（color 传入近似色），但窗口底色仍应保持主题原色。
   */
  mainWindow.setBackgroundColor(THEME_COLORS[resolveNativeTheme()].background);
  try {
    mainWindow.setTitleBarOverlay({
      color,
      symbolColor,
      height: TITLEBAR_HEIGHT,
    });
  } catch {
    // 平台不支持（如 macOS）时忽略
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const lang = router.getSettings().language;
  const appName = app.name;
  const t = (key: MessageKey, vars?: Record<string, string | number>) =>
    translate(lang, key, vars);

  /**
   * 单个快捷键菜单项：accelerator 触发后经 `ui:shortcut` 转发给渲染层分发，
   * 与既有 ui:open-settings / ui:add-project 的乐观更新流程保持一致。
   * accelerator 优先取用户自定义覆盖（AppSettings.shortcuts），否则用默认键位。
   */
  const overrides = router.getSettings().shortcuts;
  const shortcutItem = (action: ShortcutActionId): Electron.MenuItemConstructorOptions => {
    const def = SHORTCUTS.find((s) => s.action === action);
    if (!def) return { label: action };
    return {
      label: t(def.labelKey),
      accelerator: overrides?.[def.action] ?? def.accelerator,
      click: () => sendUi(IPC.UI_SHORTCUT, { action: def.action }),
    };
  };
  /** switch-tab 是 indexed（1..9）动作，需展开为 9 个子菜单项。 */
  const switchTabDef = SHORTCUTS.find((s) => s.action === 'switch-tab');
  const switchTabBase = switchTabDef
    ? overrides?.[switchTabDef.action] ?? switchTabDef.accelerator
    : 'CmdOrCtrl+1';

  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS 必须有 App 菜单（含 About / Settings / Quit），否则首项菜单行为异常
    ...(isMac
      ? [
          {
            label: appName,
            submenu: [
              { role: 'about' as const, label: t('menu.about', { name: appName }) },
              { type: 'separator' as const },
              {
                label: t('menu.settings'),
                accelerator: 'CmdOrCtrl+,',
                click: () => sendUi(IPC.UI_OPEN_SETTINGS),
              },
              { type: 'separator' as const },
              { role: 'hide' as const, label: t('menu.hide', { name: appName }) },
              { role: 'hideOthers' as const, label: t('menu.hideOthers') },
              { role: 'unhide' as const, label: t('menu.showAll') },
              { type: 'separator' as const },
              { role: 'quit' as const, label: t('menu.quit', { name: appName }) },
            ],
          },
        ]
      : []),
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.addProject'),
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => sendUi(IPC.UI_ADD_PROJECT),
        },
        { type: 'separator' as const },
        ...(isMac
          ? [
              // macOS 的 close 语义是关窗口；Settings 已放在 App 菜单（⌘,）
              { role: 'close' as const, label: t('menu.closeWindow') },
            ]
          : [
              {
                label: t('menu.settings'),
                accelerator: 'CmdOrCtrl+,',
                click: () => sendUi(IPC.UI_OPEN_SETTINGS),
              },
              { type: 'separator' as const },
              { role: 'quit' as const, label: t('menu.quit', { name: appName }) },
            ]),
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        /*
         * 复制/粘贴：undo/redo/cut/copy 走原生 role；paste 改为无快捷键的
         * 自定义项——终端里 Ctrl+V 由渲染侧自定义处理（智能粘贴文本/图片/文件），
         * 若这里仍用 `role: 'paste'`，Electron 会再给 Ctrl+V 绑一次原生粘贴，
         * 造成粘贴两次。
         */
        { role: 'undo' as const, label: t('menu.undo') },
        { role: 'redo' as const, label: t('menu.redo') },
        { type: 'separator' as const },
        { role: 'cut' as const, label: t('menu.cut') },
        { role: 'copy' as const, label: t('menu.copy') },
        /*
         * paste 按平台区分：
         * - macOS：保留 role:'paste'，菜单栏显示 ⌘V。终端里的 ⌘V 被系统菜单
         *   拦截后触发 webContents.paste()，由渲染侧 onNativePaste 兜底处理
         *   文件/图片路径插入，纯文本交 xterm 原生。
         * - Windows/Linux：用无快捷键的自定义项，避免与终端 Ctrl+V 的渲染侧
         *   自定义处理重复触发（粘贴两次）。
         */
        ...(isMac
          ? [{ role: 'paste' as const, label: t('menu.paste') }]
          : [
              {
                label: t('menu.paste'),
                click: () => mainWindow?.webContents?.paste(),
              },
            ]),
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' as const, label: t('menu.pasteAndMatchStyle') },
              { role: 'delete' as const, label: t('menu.delete') },
              { role: 'selectAll' as const, label: t('menu.selectAll') },
            ]
          : [
              { role: 'delete' as const, label: t('menu.delete') },
              { type: 'separator' as const },
              { role: 'selectAll' as const, label: t('menu.selectAll') },
            ]),
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        shortcutItem('new-tab'),
        shortcutItem('next-tab'),
        shortcutItem('previous-tab'),
        { type: 'separator' as const },
        ...(switchTabDef
          ? [
              {
                label: t('shortcuts.switchTab'),
                submenu: Array.from({ length: 9 }, (_, i) => {
                  const n = i + 1;
                  return {
                    label: t('shortcuts.switchTabN', { n }),
                    accelerator: indexedAccelerator(switchTabBase, n),
                    click: () => sendUi(IPC.UI_SHORTCUT, { action: 'switch-tab', index: n }),
                  };
                }),
              },
            ]
          : []),
        { type: 'separator' as const },
        shortcutItem('close-tab'),
        shortcutItem('rename-tab'),
        { type: 'separator' as const },
        shortcutItem('split-vertical'),
        shortcutItem('split-horizontal'),
        shortcutItem('close-pane'),
        { type: 'separator' as const },
        shortcutItem('focus-pane-left'),
        shortcutItem('focus-pane-down'),
        shortcutItem('focus-pane-up'),
        shortcutItem('focus-pane-right'),
      ],
    },
    {
      label: t('menu.help'),
      submenu: [shortcutItem('help')],
    },
    // macOS 约定：必须有 Window 菜单（Cmd+M 最小化等）
    ...(isMac
      ? [
          {
            label: t('menu.window'),
            submenu: [
              { role: 'minimize' as const, label: t('menu.minimize') },
              { role: 'zoom' as const, label: t('menu.zoom') },
              { type: 'separator' as const },
              { role: 'front' as const, label: t('menu.front') },
            ],
          },
        ]
      : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * 向渲染进程发送一条 UI 命令（菜单项触发，交由 Renderer 走既有 store 流程，
 * 保证乐观更新与 DOM 副作用一致）。
 */
function sendUi(type: string, payload: Record<string, unknown> = {}): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    win.webContents.send(type, { type, version: 1, payload });
  }
}

app.whenReady().then(async () => {
  // 安全网：任何未捕获异常都不应让主进程弹崩溃对话框。
  // IPC 处理器内的可预期失败（命令不存在等）已在 router 中转成 app:error 消息。
  process.on('uncaughtException', (error) => {
    console.error('[herdr-desktop] uncaught exception:', error);
    logLine('uncaught-exception', error instanceof Error ? (error.stack ?? error.message) : String(error));
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[herdr-desktop] unhandled rejection:', reason);
    logLine('unhandled-rejection', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
  });

  /*
   * 数据目录与真实 herdr 区分：app 名（菜单栏）仍是 "Herdr"，
   * 但 userData（session.json / settings.json 等）落到 `herdr-desktop`，
   * 避免同时安装 herdr 时读写冲突。
   */
  app.setPath('userData', join(app.getPath('appData'), 'herdr-desktop'));

  /*
   * 启动横幅 + 子进程异常日志。
   *
   * 必须在 setPath 之后再记第一条：日志文件落在 userData/logs 下，
   * 提前写入会落到默认的 appData/Herdr 目录。
   *
   * child-process-gone 里的 type==='GPU' 是关键信号：GPU 进程崩溃会同时打掉
   * 所有 pane 的 WebGL 上下文，正是「所有终端同一瞬间一起花屏」的直接证据。
   */
  logLine(
    'app',
    `start version=${app.getVersion()} electron=${process.versions.electron} platform=${process.platform}`,
  );
  app.on('child-process-gone', (_event, details) => {
    const extra = details.name ? ` name=${details.name}` : '';
    logLine(
      'child-process-gone',
      `type=${details.type} reason=${details.reason} exitCode=${details.exitCode}${extra}`,
    );
  });

  /** <webview> 崩溃后自动重载的次数上限与延迟（见下方说明）。 */
  const MAX_WEBVIEW_RELOADS = 2;
  const WEBVIEW_RELOAD_DELAY_MS = 300;

  /*
   * 渲染进程 console 落盘 —— 覆盖**所有** webContents，含 <webview>。
   *
   * 不能只在主窗口上挂：DSH web agent 那个 <webview> 是独立的 webContents，
   * 主窗口的监听根本收不到它的日志。这里统一挂载，标签带上类型与 id，
   * 同时开多个 web pane 时能分清是谁输出的。
   *
   * 注册必须早于 createMainWindow()，否则主窗口自己的首屏日志会漏掉。
   * 注意参数形态：Electron 44 把详情挂在**第一个**参数上（`level` / `message`），
   * 后面那几个 level/message 形参是已废弃的旧接口，按老签名取值拿不到数据。
   */
  app.on('web-contents-created', (_event, contents) => {
    const type = contents.getType();
    const prefix = `renderer:${type}#${contents.id}`;
    /** 这个 webContents 已经被自动重载过几次。 */
    let webviewReloads = 0;

    contents.on('console-message', (details) => {
      /*
       * <webview> 常驻不卸载（切标签只改 display，见 Layout），DSH web GUI 的
       * info 级日志会持续涌入；它和终端共用同一个 2000 行缓冲，刷屏时会把终端侧
       * 的关键告警（webgl context lost 之类）挤掉。因此 webview 只留 warning/error，
       * 主窗口保持全量。
       */
      if (type === 'webview' && details.level !== 'warning' && details.level !== 'error') {
        return;
      }
      logLine(`${prefix}:${details.level}`, details.message);
    });

    /*
     * 记录「编号 → 地址」的映射。
     *
     * 标签里的 #id 是进程内自增编号，重启后会变；有了这条导航记录，就能把
     * `renderer:webview#12:error` 对应到具体是哪个 web pane 的哪个地址。
     *
     * 只订阅 did-navigate（整页加载），不用 did-navigate-in-page：
     * DSH web GUI 是 SPA，站内路由会频繁触发后者，把日志冲成噪声。
     * 崩溃自动重载之后也会重新触发一次 did-navigate，映射自动刷新。
     */
    contents.on('did-navigate', (_e, url) => {
      logLine(`${prefix}:navigate`, url);
    });

    /*
     * 渲染进程崩溃也在这里统一记录：主窗口原本自己记了一份，但 <webview>
     * 崩掉时没人记录。统一到这一处，避免主窗口被记两遍。
     */
    contents.on('render-process-gone', (_e, details) => {
      logLine(`${prefix}:process-gone`, `reason=${details.reason} exitCode=${details.exitCode}`);

      /*
       * <webview> 崩溃后不会自愈，web pane 会停在空白状态，用户只能手动点重启，
       * 这里自动重载一次让它自己恢复。主窗口不在此列——它崩溃后已无法交互，
       * 由 createMainWindow 里的处理器直接收窗口。
       *
       * 次数封顶 2 次：崩溃若是确定性的（页面自身问题），无限重载会变成
       * 崩溃-重载死循环。用完后就停在坏状态，靠手动重启恢复——重建 <webview>
       * 会换一个新的 webContents，计数自然归零。
       */
      if (type !== 'webview' || contents.isDestroyed()) return;
      if (webviewReloads >= MAX_WEBVIEW_RELOADS) {
        // 放弃自动恢复也要留痕，否则日志里只剩崩溃记录，看不出我们已经不再重试
        logLine(`${prefix}:reload-giveup`, `attempts=${webviewReloads}`);
        return;
      }
      webviewReloads += 1;
      setTimeout(() => {
        if (!contents.isDestroyed()) contents.reload();
      }, WEBVIEW_RELOAD_DELAY_MS);
    });
  });

  router = new IpcRouter();
  router.loadSettings();
  /*
   * 启动期校验：所有 manifest 的 region 名必须能被解析（附录 D #21）。
   *
   * region 名是静态数据，写错是开发期错误 —— 在这里炸掉，好过让某个智能体的
   * 检测规则静默失效、用户只看到「状态一直不对」。放在 restoreSession 之前：
   * 恢复会话会启动 pane，那时就会用到检测规则。
   */
  validateManifestRegionsAtStartup();
  router.onTitleBarTheme = setTitleBarOverlay;
  // 语言变化会改变菜单文案，交给 buildMenu 重建
  router.onLanguageChange = buildMenu;
  // 快捷键覆盖变化会改变菜单 accelerator，交给 buildMenu 重建
  router.onShortcutsChange = buildMenu;
  // 恢复上次会话（项目/agent 元数据）。必须在创建窗口前完成，
  // 这样 did-finish-load 推送的首个快照就包含恢复结果，渲染端无需二次同步。
  await router.restoreSession();
  router.register();
  // hook 上报端点在创建窗口/spawn agent 之前启动，保证环境变量注入时有地址。
  await router.startHookServer();
  ipcMain.handle('herdr-desktop:app-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));
  ipcMain.handle('herdr-desktop:read-clipboard', () => readClipboard());
  ipcMain.handle('herdr-desktop:settings', () => router.getSettings());
  ipcMain.handle('herdr-desktop:hook-statuses', () => router.getHookStatuses());
  ipcMain.handle('herdr-desktop:hook-install', (_event, agentId: string) => router.installHook(agentId));
  ipcMain.handle('herdr-desktop:hook-uninstall', (_event, agentId: string) => router.uninstallHook(agentId));
  buildMenu();
  createMainWindow();
});

/**
 * 退出前收尾。
 *
 * 关闭窗口即退出应用（各平台一致，含 macOS，见下方 window-all-closed），
 * 所以退出路径只有收尾、没有二次确认。
 *
 * 收尾动作是回收 web agent 与 hook 上报端点、排空挂起的持久化写入，避免
 * 最后一次结构变更丢失。清理是异步的，所以先 preventDefault 拦住本次退出，
 * 等 flush 结束后重新 app.quit()；exitCleanupStarted 保证只清理一次，
 * 否则 preventDefault → quit 会变成死循环。
 */
let exitCleanupStarted = false;
app.on('before-quit', (event) => {
  if (exitCleanupStarted) return;
  exitCleanupStarted = true;
  event.preventDefault();
  // 先结束 dsh web 子进程树与 hook 上报端点，再排空持久化写入
  // 先释放状态服务的定时器、结束 dsh web 子进程树与 hook 上报端点，再排空持久化写入
  router.disposeAgentState();
  router.disposeWebAgents();
  router.disposeHookServer();
  void router.flush().finally(() => {
    // 日志缓冲是异步落盘的，退出前同步补写，否则最后几条（往往最有用）会丢
    flushLogSync();
    app.quit();
  });
});

/*
 * 关掉最后一个窗口即退出应用（各平台一致，含 macOS）。
 *
 * 应用没有窗口就无法操作，继续驻留只会留下一个无法交互的进程。
 * 显式写出来是因为这里刻意不沿用 macOS「关窗后驻留 Dock」的惯例——
 * 那套惯例依赖 app.on('activate') 重建窗口，而退出清理是异步的，
 * 清理期间恰好处于「零窗口但仍在运行」的状态，Dock 点击会把窗口又拉回来。
 */
app.on('window-all-closed', () => {
  app.quit();
});
