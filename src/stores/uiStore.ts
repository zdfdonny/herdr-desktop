/**
 * ui store —— 纯界面导航状态（不持久化）。
 *
 * 设置以弹窗形式覆盖在主区域之上，终端始终保持挂载与运行。
 */

import { create } from 'zustand';

/** 应用内确认对话框的数据。 */
export interface ConfirmState {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
}

interface UiStore {
  /** 设置弹窗是否打开。 */
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  toggleSettings: () => void;
  /**
   * 请求打开某项目的新建 agent 选择器（由菜单 Cmd/Ctrl+T 触发）。
   *
   * nonce 保证对同一项目重复请求也能触发 effect；消费方（ProjectGroup）
   * 打开后调用 clearOpenAgentPickerRequest 清除。
   */
  openAgentPickerRequest: { projectId: string; nonce: number } | null;
  requestOpenAgentPicker: (projectId: string) => void;
  clearOpenAgentPickerRequest: () => void;
  /** 应用内确认对话框（替代原生 confirm()）。 */
  confirm: ConfirmState | null;
  openConfirm: (confirm: ConfirmState) => void;
  closeConfirm: () => void;
}

export const useUiStore = create<UiStore>((set, get) => ({
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSettings: () => set({ settingsOpen: !get().settingsOpen }),
  openAgentPickerRequest: null,
  requestOpenAgentPicker: (projectId) =>
    set({ openAgentPickerRequest: { projectId, nonce: Date.now() } }),
  clearOpenAgentPickerRequest: () => set({ openAgentPickerRequest: null }),
  confirm: null,
  openConfirm: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: null }),
}));

export function useSettingsOpen(): boolean {
  return useUiStore((s) => s.settingsOpen);
}
