/**
 * 桌面能力相关的 IPC 注册（不改变会话拓扑）。
 *
 * 从 `IpcRouter.register()` 拆出的第三组：
 * - 目录选择对话框（添加项目时用）；
 * - agent 命令可用性探测；
 * - 代理连通性检测。
 *
 * 这三个都用 `ipcMain.handle`（需要返回值），且与 pane 状态无关。
 */

import { BrowserWindow, dialog, ipcMain } from 'electron';

/** 通道名常量：这些是裸字符串，不在 `IPC` 常量表里（历史原因，保持不变以兼容渲染端）。 */
export const DIALOG_CHANNELS = {
  pickDirectory: 'herdr-desktop:pick-directory',
  agentAvailability: 'herdr-desktop:agent-availability',
  testProxy: 'herdr-desktop:test-proxy',
} as const;

/** 本模块需要宿主提供的能力。 */
export interface DialogHandlerHost {
  /** 探测一批命令在本机是否可用（PATH 解析结果）。 */
  probeAgentAvailability(commands: string[]): Record<string, boolean>;
}

/** 代理连通性检测实现（由调用方传入，便于测试替换）。 */
export type ProxyTester = (url: string) => Promise<unknown>;

/** 注册桌面能力相关的通道。 */
export function registerDialogHandlers(host: DialogHandlerHost, testProxy: ProxyTester): void {
  // 目录选择对话框（添加项目）
  ipcMain.handle(DIALOG_CHANNELS.pickDirectory, async (_event, options?: { title?: string }) => {
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
  ipcMain.handle(DIALOG_CHANNELS.agentAvailability, (_event, commands: string[]) => {
    return host.probeAgentAvailability(Array.isArray(commands) ? commands : []);
  });

  // 代理连通性检测
  ipcMain.handle(DIALOG_CHANNELS.testProxy, (_event, url: string) => {
    return testProxy(url);
  });
}

