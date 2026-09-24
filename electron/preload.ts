/**
 * preload 脚本 —— 通过 contextBridge 暴露类型化 API 给 Renderer。
 *
 * 只暴露最小必要的安全接口，不暴露 ipcRenderer 原对象。
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './ipc/protocol';
import type {
  HerdrDesktopApi,
  ControlMessage,
  MainToRendererMessage,
  AppSettings,
  ProxyTestResult,
} from '../shared/protocol';

const MESSAGE_CHANNELS = [
  IPC.STATE_SNAPSHOT,
  IPC.STATE_PATCH,
  IPC.STATE_SETTINGS,
  IPC.PTY_DATA,
  IPC.PTY_EXIT,
  IPC.APP_INFO,
  IPC.APP_ERROR,
  IPC.AGENT_STATUS,
  IPC.AGENT_AVAILABILITY,
  IPC.NEW_AGENT,
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
    return ipcRenderer.invoke('herdr:app-info');
  },
  pickDirectory(options?: { title?: string }): Promise<string | null> {
    return ipcRenderer.invoke('herdr:pick-directory', options);
  },
  getSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke('herdr:settings');
  },
  getAgentAvailability(commands: string[]): Promise<Record<string, boolean>> {
    return ipcRenderer.invoke('herdr:agent-availability', commands);
  },
  testProxy(url: string): Promise<ProxyTestResult> {
    return ipcRenderer.invoke('herdr:test-proxy', url);
  },
};

contextBridge.exposeInMainWorld('herdrDesktop', api);
