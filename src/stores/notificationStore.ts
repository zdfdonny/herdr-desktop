/**
 * notifications store —— 用户可见的错误与提示。
 *
 * 存储的是文案 key 而非渲染后的字符串，
 * 因此切换语言后已存在的通知也会随之更新。
 */

import { create } from 'zustand';

export interface AppNotification {
  id: string;
  kind: 'error' | 'info';
  titleKey: string;
  titleVars?: Record<string, string | number>;
  detailKey?: string;
  detailVars?: Record<string, string | number>;
  /** 毫秒时间戳。 */
  createdAt: number;
}

interface NotificationStore {
  notifications: AppNotification[];
  push: (n: Omit<AppNotification, 'id' | 'createdAt'>) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

let counter = 0;

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],
  push: (n) => {
    counter += 1;
    const notification: AppNotification = {
      ...n,
      id: `n-${counter}`,
      createdAt: Date.now(),
    };
    set((state) => ({ notifications: [...state.notifications, notification] }));
  },
  dismiss: (id) =>
    set((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) })),
  clear: () => set({ notifications: [] }),
}));
