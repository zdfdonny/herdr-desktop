/**
 * web store —— DeepSeek Harness Web pane 的认证链接缓存。
 *
 * 认证链接（带 token 查询参数）是进程内敏感信息，Main 通过 `web:ready`
 * 下发，绝不写入 session.json。这里只做**非持久化**的 paneId → url 映射，
 * 供 WebPane 挂载时读取，并随快照剪除已关闭 pane 的条目。
 */

import { create } from 'zustand';

interface WebStore {
  /** paneId → 带 token 的认证链接。 */
  urls: Record<string, string>;
  /**
   * paneId → 该 pane 新建时应该注入的 DSH 会话 id（null 表示恢复模式，不注入）。
   * 仅新建模式由 Main 下发会话 id；恢复模式下为 null，让该 pane partition 里
   * 已有的 localStorage 恢复它上次的会话。
   */
  sessionIds: Record<string, string | null>;
  setUrl: (paneId: string, url: string) => void;
  setSessionId: (paneId: string, sessionId: string | null) => void;
  /** 剪除不在 `paneIds` 中的条目。 */
  prune: (paneIds: string[]) => void;
}

export const useWebStore = create<WebStore>((set) => ({
  urls: {},
  sessionIds: {},

  setUrl: (paneId, url) =>
    set((state) => ({ urls: { ...state.urls, [paneId]: url } })),

  setSessionId: (paneId, sessionId) =>
    set((state) => ({ sessionIds: { ...state.sessionIds, [paneId]: sessionId } })),

  prune: (paneIds) =>
    set((state) => {
      const valid = new Set(paneIds);
      const urls: Record<string, string> = {};
      const sessionIds: Record<string, string | null> = {};
      for (const [paneId, url] of Object.entries(state.urls)) {
        if (valid.has(paneId)) urls[paneId] = url;
      }
      for (const [paneId, sessionId] of Object.entries(state.sessionIds)) {
        if (valid.has(paneId)) sessionIds[paneId] = sessionId;
      }
      return { urls, sessionIds };
    }),
}));
