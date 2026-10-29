/**
 * 设置与外观相关的 IPC 注册。
 *
 * 从 `IpcRouter.register()` 拆出的第一组。这一组通道只碰设置持久化与主题/语言/快捷键
 * 的副作用，与 pane 生命周期完全无关 —— 之前它们和 agent 操作挤在同一个 132 行的
 * `register()` 里，改一个通道要在无关代码之间穿梭。
 *
 * 依赖通过**窄接口**注入：本模块不认识 `IpcRouter` 的整体，只用这几个能力。
 */

import { ipcMain } from 'electron';
import type { AppSettings, Language, ThemePreference } from '../../../shared/state';
import { IPC } from '../channels';

/** 本模块需要宿主提供的能力（窄接口，避免依赖整个 router）。 */
export interface SettingsHandlerHost {
  readonly settings: {
    setTheme(theme: ThemePreference): Promise<SettingsSnapshot>;
    setLanguage(language: Language): Promise<SettingsSnapshot>;
    setFontSize(fontSize: number): Promise<SettingsSnapshot>;
    setProxyUrl(url: string): Promise<SettingsSnapshot>;
    setAgentProxy(command: string, enabled: boolean): Promise<SettingsSnapshot>;
    setIntegrationsOnboarded(onboarded: boolean): Promise<SettingsSnapshot>;
    setSoundEnabled(enabled: boolean): Promise<SettingsSnapshot>;
    setToastEnabled(enabled: boolean): Promise<SettingsSnapshot>;
    setShortcut(action: string, accelerator: string | null): Promise<SettingsSnapshot>;
    resetShortcuts(): Promise<SettingsSnapshot>;
  };
  /** 设置变更后推给渲染端。 */
  pushSettings(settings: SettingsSnapshot): void;
  /** 主题变化后同步原生窗口配色。 */
  syncNativeTheme(theme: ThemePreference): void;
  /** 标题栏叠加层配色（由 main 注入）。 */
  readonly onTitleBarTheme?: (color: string, symbolColor: string) => void;
  /** 语言切换后的回调（重建菜单）。 */
  readonly onLanguageChange?: () => void;
  /** 快捷键变更后的回调（重建菜单 accelerator）。 */
  readonly onShortcutsChange?: () => void;
  /** 进入/退出快捷键录制模式。 */
  setShortcutCaptureMode(capturing: boolean): void;
}

/** 设置快照（与 SettingsStore.get() 同构）。 */
export type SettingsSnapshot = AppSettings;

/** 注册设置与外观相关的通道。 */
export function registerSettingsHandlers(host: SettingsHandlerHost): void {
  ipcMain.on(IPC.SET_THEME, (_event, payload: { theme: ThemePreference }) => {
    void host.settings.setTheme(payload.theme).then((settings) => {
      host.syncNativeTheme(settings.theme);
      host.pushSettings(settings);
    });
  });

  ipcMain.on(
    IPC.SET_TITLEBAR_THEME,
    (_event, payload: { color: string; symbolColor: string }) => {
      host.onTitleBarTheme?.(payload.color, payload.symbolColor);
    },
  );

  ipcMain.on(IPC.SET_LANGUAGE, (_event, payload: { language: Language }) => {
    void host.settings.setLanguage(payload.language).then((settings) => {
      host.pushSettings(settings);
      host.onLanguageChange?.();
    });
  });

  ipcMain.on(IPC.SET_FONT_SIZE, (_event, payload: { fontSize: number }) => {
    void host.settings.setFontSize(payload.fontSize).then((settings) => host.pushSettings(settings));
  });

  ipcMain.on(IPC.SET_PROXY_URL, (_event, payload: { url: string }) => {
    void host.settings.setProxyUrl(payload.url).then((settings) => host.pushSettings(settings));
  });

  ipcMain.on(
    IPC.SET_AGENT_PROXY,
    (_event, payload: { command: string; enabled: boolean }) => {
      void host.settings
        .setAgentProxy(payload.command, payload.enabled)
        .then((settings) => host.pushSettings(settings));
    },
  );

  ipcMain.on(
    IPC.SET_INTEGRATIONS_ONBOARDED,
    (_event, payload: { onboarded: boolean }) => {
      void host.settings
        .setIntegrationsOnboarded(payload.onboarded)
        .then((settings) => host.pushSettings(settings));
    },
  );

  ipcMain.on(IPC.SET_SOUND_ENABLED, (_event, payload: { enabled: boolean }) => {
    void host.settings.setSoundEnabled(payload.enabled).then((settings) => host.pushSettings(settings));
  });

  ipcMain.on(IPC.SET_TOAST_ENABLED, (_event, payload: { enabled: boolean }) => {
    void host.settings.setToastEnabled(payload.enabled).then((settings) => host.pushSettings(settings));
  });

  ipcMain.on(
    IPC.SET_SHORTCUT,
    (_event, payload: { action: string; accelerator: string | null }) => {
      void host.settings.setShortcut(payload.action, payload.accelerator).then((settings) => {
        host.pushSettings(settings);
        host.onShortcutsChange?.();
      });
    },
  );

  ipcMain.on(IPC.RESET_SHORTCUTS, () => {
    void host.settings.resetShortcuts().then((settings) => {
      host.pushSettings(settings);
      host.onShortcutsChange?.();
    });
  });

  ipcMain.on(IPC.BEGIN_SHORTCUT_CAPTURE, () => host.setShortcutCaptureMode(true));
  ipcMain.on(IPC.END_SHORTCUT_CAPTURE, () => host.setShortcutCaptureMode(false));
}
