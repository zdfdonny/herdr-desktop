/**
 * Electron 主进程入口 —— 对应 herdr `src/main.rs` 的角色。
 *
 * 创建窗口、注册 IPC、管理 Agent 运行时生命周期。
 */

import { app, BrowserWindow, Menu, shell, ipcMain, nativeTheme } from 'electron';
import { join } from 'node:path';
import { IpcRouter } from './ipc/router';
import { IPC } from './ipc/protocol';
import { readClipboard } from './runtime/clipboard';
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
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[herdr-desktop] unhandled rejection:', reason);
  });

  /*
   * 数据目录与真实 herdr 区分：app 名（菜单栏）仍是 "Herdr"，
   * 但 userData（session.json / settings.json 等）落到 `herdr-desktop`，
   * 避免同时安装 herdr 时读写冲突。
   */
  app.setPath('userData', join(app.getPath('appData'), 'herdr-desktop'));

  router = new IpcRouter();
  router.loadSettings();
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
  ipcMain.handle('herdr:app-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));
  ipcMain.handle('herdr:read-clipboard', () => readClipboard());
  ipcMain.handle('herdr:settings', () => router.getSettings());
  ipcMain.handle('herdr:hook-statuses', () => router.getHookStatuses());
  ipcMain.handle('herdr:hook-install', (_event, agentId: string) => router.installHook(agentId));
  ipcMain.handle('herdr:hook-uninstall', (_event, agentId: string) => router.uninstallHook(agentId));
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
  router.disposeWebAgents();
  router.disposeHookServer();
  void router.flush().finally(() => app.quit());
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
