/**
 * settings store —— 主题、语言、字号、侧栏状态（Renderer 侧镜像）。
 *
 * 真值源在 Main 进程（userData/settings.json），此处做乐观更新 +
 * 统一设置入口，切换后由 Main 回推最终值。
 */

import { create } from 'zustand';
import type { AppSettings, ThemePreference, Language, ResolvedTheme } from '@shared/state';
import {
  sendSetTheme,
  sendSetLanguage,
  sendSetFontSize,
  sendSetSidebar,
  sendSetProxyUrl,
  sendSetAgentProxy,
} from '../ipc/client';
import { useI18nStore } from '../i18n';

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  language: 'zh-CN',
  fontSize: 13,
  sidebarCollapsed: false,
  proxyUrl: '',
  proxyAgents: {},
};

/** 由偏好 + 系统外观解析出实际主题。 */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }
  return preference;
}

/**
 * 把主题写到 <html data-theme>。
 *
 * 同步执行，保证任何依赖 CSS 变量的读取（如 xterm 配色）都能拿到新值。
 */
export function applyThemeToDom(preference: ThemePreference): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', preference);
  // 让表单控件、滚动条等使用匹配的配色
  document.documentElement.style.colorScheme =
    preference === 'system' ? 'light dark' : preference;
}

/** 把语言写到 <html lang>，供 CSS 与无障碍使用。 */
export function applyLanguageToDom(language: Language): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('lang', language);
}

interface SettingsStore {
  settings: AppSettings;
  systemPrefersDark: boolean;
  applySettings: (settings: AppSettings) => void;
  setSystemPrefersDark: (dark: boolean) => void;
  setTheme: (theme: ThemePreference) => void;
  setLanguage: (language: Language) => void;
  setFontSize: (fontSize: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setProxyUrl: (url: string) => void;
  setAgentProxy: (command: string, enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  systemPrefersDark:
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true,

  applySettings: (settings) => {
    set({ settings });
    applyThemeToDom(settings.theme);
    applyLanguageToDom(settings.language);
    // 语言是渲染层状态，需同步到 i18n store
    useI18nStore.getState().setLanguage(settings.language);
  },

  setSystemPrefersDark: (dark) => {
    set({ systemPrefersDark: dark });
    // system 模式下需要重新应用 DOM 属性（触发 CSS 媒体查询分支）
    if (get().settings.theme === 'system') {
      applyThemeToDom('system');
    }
  },

  setTheme: (theme) => {
    set((s) => ({ settings: { ...s.settings, theme } }));
    applyThemeToDom(theme);
    sendSetTheme(theme);
  },

  setLanguage: (language) => {
    set((s) => ({ settings: { ...s.settings, language } }));
    applyLanguageToDom(language);
    useI18nStore.getState().setLanguage(language);
    sendSetLanguage(language);
  },

  setFontSize: (fontSize) => {
    set((s) => ({ settings: { ...s.settings, fontSize } }));
    sendSetFontSize(fontSize);
  },

  setSidebarCollapsed: (collapsed) => {
    set((s) => ({ settings: { ...s.settings, sidebarCollapsed: collapsed } }));
    sendSetSidebar(collapsed);
  },

  setProxyUrl: (url) => {
    set((s) => ({ settings: { ...s.settings, proxyUrl: url } }));
    sendSetProxyUrl(url);
  },

  setAgentProxy: (command, enabled) => {
    set((s) => {
      const proxyAgents = { ...s.settings.proxyAgents };
      if (enabled) {
        proxyAgents[command] = true;
      } else {
        delete proxyAgents[command];
      }
      return { settings: { ...s.settings, proxyAgents } };
    });
    sendSetAgentProxy(command, enabled);
  },
}));

/** 当前实际生效的主题。 */
export function useResolvedTheme(): ResolvedTheme {
  const theme = useSettingsStore((s) => s.settings.theme);
  const systemPrefersDark = useSettingsStore((s) => s.systemPrefersDark);
  return resolveTheme(theme, systemPrefersDark);
}

/** 侧栏是否折叠。 */
export function useSidebarCollapsed(): boolean {
  return useSettingsStore((s) => s.settings.sidebarCollapsed);
}
