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
  setUrl: (paneId: string, url: string) => void;
  /** 剪除不在 `paneIds` 中的条目。 */
  prune: (paneIds: string[]) => void;
}

export const useWebStore = create<WebStore>((set) => ({
  urls: {},

  setUrl: (paneId, url) =>
    set((state) => ({ urls: { ...state.urls, [paneId]: url } })),

  prune: (paneIds) =>
    set((state) => {
      const valid = new Set(paneIds);
      const urls: Record<string, string> = {};
      for (const [paneId, url] of Object.entries(state.urls)) {
        if (valid.has(paneId)) urls[paneId] = url;
      }
      return { urls };
    }),
}));
