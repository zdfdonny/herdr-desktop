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
export type SettingsSection = 'general' | 'proxy' | 'shortcuts' | 'about';

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
  /** 首次启动的集成引导弹窗是否打开（瞬态，不持久化）。 */
  integrationsOnboardingOpen: boolean;
  openIntegrationsOnboarding: () => void;
  closeIntegrationsOnboarding: () => void;
  /** 正在重命名的视图标签 id（null 表示无）。 */
  renamingViewId: string | null;
  startRenameView: (viewId: string) => void;
  stopRenameView: () => void;
  /** 快捷键帮助弹窗是否打开。 */
  shortcutHelpOpen: boolean;
  openShortcutHelp: () => void;
  closeShortcutHelp: () => void;
  toggleShortcutHelp: () => void;
  /** 当前打开的模态弹窗计数（Modal 组件挂载/卸载时增减，供标题栏遮罩原生按钮）。 */
  modalCount: number;
  openModal: () => void;
  closeModal: () => void;
  /** 是否正在捕获改键组合键（供全局 pane 快捷键处理跳过，避免干扰捕获）。 */
  shortcutCapturing: boolean;
  setShortcutCapturing: (capturing: boolean) => void;
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
  integrationsOnboardingOpen: false,
  openIntegrationsOnboarding: () => set({ integrationsOnboardingOpen: true }),
  closeIntegrationsOnboarding: () => set({ integrationsOnboardingOpen: false }),
  renamingViewId: null,
  startRenameView: (viewId) => set({ renamingViewId: viewId }),
  stopRenameView: () => set({ renamingViewId: null }),
  shortcutHelpOpen: false,
  openShortcutHelp: () => set({ shortcutHelpOpen: true }),
  closeShortcutHelp: () => set({ shortcutHelpOpen: false }),
  toggleShortcutHelp: () => set({ shortcutHelpOpen: !get().shortcutHelpOpen }),
  modalCount: 0,
  openModal: () => set((s) => ({ modalCount: s.modalCount + 1 })),
  closeModal: () => set((s) => ({ modalCount: Math.max(0, s.modalCount - 1) })),
  shortcutCapturing: false,
  setShortcutCapturing: (capturing) => set({ shortcutCapturing: capturing }),
}));

export function useSettingsOpen(): boolean {
  return useUiStore((s) => s.settingsOpen);
}

/** 当前是否有任一模态弹窗打开。 */
export function useAnyModalOpen(): boolean {
  return useUiStore((s) => s.modalCount > 0);
}
