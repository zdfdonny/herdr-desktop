/**
 * ThemeSwitch —— 主题切换三段控件（跟随系统 / 浅色 / 深色）。
 *
 * 主区域顶部栏与设置弹窗共用同一视觉语言，因此抽成组件。
 */

import { useSettingsStore } from '../stores/settingsStore';
import { useT } from '../i18n';
import { IconThemeSystem, IconThemeLight, IconThemeDark } from './icons';
import type { ThemePreference } from '@shared/state';
import type { MessageKey } from '../i18n/messages';

const THEME_OPTIONS: Array<{
  value: ThemePreference;
  Icon: (props: { size?: number }) => React.ReactElement;
  labelKey: MessageKey;
}> = [
  { value: 'system', Icon: IconThemeSystem, labelKey: 'theme.system' },
  { value: 'light', Icon: IconThemeLight, labelKey: 'theme.light' },
  { value: 'dark', Icon: IconThemeDark, labelKey: 'theme.dark' },
];

export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const theme = useSettingsStore((s) => s.settings.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  return (
    <div className="theme-switch" role="radiogroup" aria-label={t('settings.theme')}>
      {THEME_OPTIONS.map((option) => {
        const label = t(option.labelKey);
        const active = theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={`theme-switch__button ${active ? 'theme-switch__button--active' : ''}`}
            onClick={() => setTheme(option.value)}
            title={label}
            aria-label={label}
          >
            <option.Icon size={compact ? 13 : 14} />
          </button>
        );
      })}
    </div>
  );
}

