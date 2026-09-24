/**
 * i18n store —— 当前语言与翻译函数。
 *
 * 语言状态与 settingsStore 同源（都来自 AppSettings），
 * 此处只提供便捷的 `t()` 与语言切换命令。
 */

import { create } from 'zustand';
import type { Language } from '@shared/state';
import { translate, type MessageKey } from './messages';

interface I18nStore {
  language: Language;
  setLanguage: (language: Language) => void;
}

export const useI18nStore = create<I18nStore>((set) => ({
  // 默认中文
  language: 'zh-CN',
  setLanguage: (language) => set({ language }),
}));

/** 当前语言。 */
export function useLanguage(): Language {
  return useI18nStore((s) => s.language);
}

/**
 * 翻译 hook。
 *
 * 返回的 `t` 依赖当前语言，语言切换时使用它的组件会重新渲染。
 */
export function useT() {
  const language = useI18nStore((s) => s.language);
  return (key: MessageKey, vars?: Record<string, string | number>) =>
    translate(language, key, vars);
}

/**
 * 复数翻译 hook。
 *
 * 中文无复数变化，英文按 count 选 one/other。
 * `base` 为基础路径，如 `'sidebar.projectCount'` 对应
 * `sidebar.projectCountOne` / `sidebar.projectCountOther`。
 */
export function usePlural() {
  const language = useI18nStore((s) => s.language);
  return (base: string, count: number) => {
    const suffix = count === 1 ? 'One' : 'Other';
    return translate(language, `${base}${suffix}` as MessageKey, { count });
  };
}

/** 非组件环境下的翻译（store / 命令中调用）。 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(useI18nStore.getState().language, key, vars);
}
