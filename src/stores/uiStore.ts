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

/** 设置弹窗的分类（与 SettingsDialog 的左侧导航一致）。 */
export type SettingsSection = 'general' | 'proxy' | 'about';

/** 左侧栏可展开的内容分区（图标栏上的两个入口）。 */
export type SidebarSection = 'projects' | 'integrations';

interface UiStore {
  /** 设置弹窗是否打开。 */
  settingsOpen: boolean;
  /** 打开设置弹窗时要展示的分类；null 表示默认「通用」。 */
  settingsSection: SettingsSection | null;
  openSettings: (section?: SettingsSection | null) => void;
  closeSettings: () => void;
  toggleSettings: () => void;
  /** 侧栏当前选中的分区；null 表示收起（只显示图标栏）。 */
  sidebarSection: SidebarSection | null;
  selectSidebarSection: (section: SidebarSection) => void;
  toggleSidebarSection: (section: SidebarSection) => void;
  /** 应用内确认对话框（替代原生 confirm()）。 */
  confirm: ConfirmState | null;
  openConfirm: (confirm: ConfirmState) => void;
  closeConfirm: () => void;
}

export const useUiStore = create<UiStore>((set, get) => ({
  settingsOpen: false,
  settingsSection: null,
  openSettings: (section = null) => set({ settingsOpen: true, settingsSection: section }),
  closeSettings: () => set({ settingsOpen: false, settingsSection: null }),
  toggleSettings: () =>
    set({ settingsOpen: !get().settingsOpen, settingsSection: get().settingsOpen ? null : get().settingsSection }),
  // 启动默认选中「项目」并展开
  sidebarSection: 'projects',
  selectSidebarSection: (section) => set({ sidebarSection: section }),
  toggleSidebarSection: (section) =>
    set({ sidebarSection: get().sidebarSection === section ? null : section }),
  confirm: null,
  openConfirm: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: null }),
}));

export function useSettingsOpen(): boolean {
  return useUiStore((s) => s.settingsOpen);
}
