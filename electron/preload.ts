/**
 * preload 脚本 —— 通过 contextBridge 暴露类型化 API 给 Renderer。
 *
 * 只暴露最小必要的安全接口，不暴露 ipcRenderer 原对象。
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC } from './ipc/channels';
import type {
  HerdrDesktopApi,
  ControlMessage,
  MainToRendererMessage,
  AppSettings,
  ProxyTestResult,
  ClipboardPayload,
} from '../shared/protocol';

const MESSAGE_CHANNELS = [
  IPC.STATE_SNAPSHOT,
  IPC.STATE_PATCH,
  IPC.STATE_SETTINGS,
  IPC.PTY_DATA,
  IPC.PTY_EXIT,
  IPC.PTY_RESET,
  IPC.APP_INFO,
  IPC.APP_ERROR,
  IPC.AGENT_STATUS,
  IPC.AGENT_AVAILABILITY,
  IPC.UI_OPEN_SETTINGS,
  IPC.UI_ADD_PROJECT,
  IPC.UI_SHORTCUT,
  IPC.WEB_READY,
] as const;

const api: HerdrDesktopApi = {
  sendControl(message: ControlMessage): void {
    ipcRenderer.send(message.type, message.payload);
  },
  onMessage(callback: (message: MainToRendererMessage) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, message: MainToRendererMessage) => {
      callback(message);
    };
    for (const ch of MESSAGE_CHANNELS) {
      ipcRenderer.on(ch, listener);
    }
    return () => {
      for (const ch of MESSAGE_CHANNELS) {
        ipcRenderer.removeListener(ch, listener);
      }
    };
  },
  getAppInfo(): Promise<{ version: string; platform: string }> {
    return ipcRenderer.invoke('herdr-desktop:app-info');
  },
  pickDirectory(options?: { title?: string }): Promise<string | null> {
    return ipcRenderer.invoke('herdr-desktop:pick-directory', options);
  },
  getSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke('herdr-desktop:settings');
  },
  getAgentAvailability(commands: string[]): Promise<Record<string, boolean>> {
    return ipcRenderer.invoke('herdr-desktop:agent-availability', commands);
  },
  testProxy(url: string): Promise<ProxyTestResult> {
    return ipcRenderer.invoke('herdr-desktop:test-proxy', url);
  },
  getHookStatuses(): Promise<Record<string, import('../shared/protocol').HookStatus>> {
    return ipcRenderer.invoke('herdr-desktop:hook-statuses');
  },
  installHook(agentId: string): Promise<import('../shared/protocol').HookStatus> {
    return ipcRenderer.invoke('herdr-desktop:hook-install', agentId);
  },
  uninstallHook(agentId: string): Promise<import('../shared/protocol').HookStatus> {
    return ipcRenderer.invoke('herdr-desktop:hook-uninstall', agentId);
  },
  setIntegrationsOnboarded(onboarded: boolean): void {
    ipcRenderer.send(IPC.SET_INTEGRATIONS_ONBOARDED, { onboarded });
  },
  readClipboard(): Promise<ClipboardPayload> {
    return ipcRenderer.invoke('herdr-desktop:read-clipboard');
  },
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
};

contextBridge.exposeInMainWorld('herdrDesktop', api);
