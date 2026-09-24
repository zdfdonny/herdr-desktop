/**
 * Electron 主进程入口 —— 对应 herdr `src/main.rs` 的角色。
 *
 * 创建窗口、注册 IPC、管理 Agent 运行时生命周期。
 */

import { app, BrowserWindow, Menu, shell, ipcMain } from 'electron';
import { join } from 'node:path';
import { IpcRouter } from './ipc/router';
import { IPC } from './ipc/protocol';

const APP_BACKGROUND = '#0d0d0d';
const DEFAULT_WINDOW = { width: 1280, height: 800, minWidth: 720, minHeight: 480 };

/** 自绘标题栏高度，需与渲染侧 CSS 中的 --titlebar-height 保持一致。 */
const TITLEBAR_HEIGHT = 36;

/**
 * 应用图标路径。
 * Windows / Linux 的窗口图标需要显式指定（打包后 electron-builder 也会写入 exe）；
 * macOS 由 app bundle 的 .icns 决定，此处的值被忽略。
 */
const APP_ICON = join(__dirname, '../../build/icon.png');

/** 标题栏叠加层配色：跟随应用主题，由渲染侧通过 IPC 更新。 */
let overlayColors = { color: '#8a8a8a', symbolColor: '#1a1a1a' };

let router: IpcRouter;
/** 主窗口引用，供标题栏配色更新使用。 */
let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...DEFAULT_WINDOW,
    backgroundColor: APP_BACKGROUND,
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
  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS 必须有 App 菜单（含 About / Quit），否则首项菜单行为异常
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Agent Pane', accelerator: 'CmdOrCtrl+T', click: () => openNewPane() },
        { type: 'separator' },
        // macOS 的 close 语义是关窗口，Windows/Linux 用 quit 更符合习惯
        isMac ? { role: 'close' as const, label: 'Close Window' } : { role: 'quit' as const },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        /*
         * 复制/粘贴交给原生 role：
         * 终端内的文本复制粘贴走 xterm 自己的 Ctrl+Shift+C/V 处理，
         * 这里的菜单项服务于输入框（搜索栏、设置、项目名等）。
         */
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' as const },
              { role: 'delete' as const },
              { role: 'selectAll' as const },
            ]
          : [{ role: 'delete' as const }, { type: 'separator' as const }, { role: 'selectAll' as const }]),
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reset Font Size',
          accelerator: 'CmdOrCtrl+0',
          click: () => router.setFontSize(13),
        },
        {
          label: 'Increase Font Size',
          accelerator: 'CmdOrCtrl+=',
          click: () => adjustFontSize(1),
        },
        {
          label: 'Decrease Font Size',
          accelerator: 'CmdOrCtrl+-',
          click: () => adjustFontSize(-1),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' as const },
      ],
    },
    // macOS 约定：必须有 Window 菜单（Cmd+M 最小化等）
    ...(isMac
      ? [
          {
            label: 'Window',
            submenu: [
              { role: 'minimize' as const },
              { role: 'zoom' as const },
              { type: 'separator' as const },
              { role: 'front' as const },
            ],
          },
        ]
      : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openNewPane(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    win.webContents.send(IPC.NEW_AGENT, {
      type: IPC.NEW_AGENT,
      version: 1,
      payload: {},
    });
  }
}

/** 菜单调整终端字号：在主进程内改当前设置并回推（渲染端会自动 fit）。 */
function adjustFontSize(delta: number): void {
  const current = router.getSettings().fontSize;
  router.setFontSize(current + delta);
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

  router = new IpcRouter();
  router.loadSettings();
  router.onTitleBarTheme = setTitleBarOverlay;
  // 恢复上次会话（项目/agent 元数据）。必须在创建窗口前完成，
  // 这样 did-finish-load 推送的首个快照就包含恢复结果，渲染端无需二次同步。
  await router.restoreSession();
  router.register();
  ipcMain.handle('herdr:app-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));
  ipcMain.handle('herdr:settings', () => router.getSettings());
  buildMenu();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

/**
 * 退出前等待挂起的持久化写入完成。
 *
 * saveState 是 fire-and-forget（每次结构变更触发一次），
 * 若用户在写入进行中退出，最后一次变更可能丢失。这里显式排空写链。
 * quitting 标记避免 preventDefault → quit 的死循环。
 */
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  // 先结束 dsh web 子进程树，再排空持久化写入
  router.disposeWebAgents();
  void router.flush().finally(() => {
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
