/**
 * ShortcutHelpDialog —— 快捷键帮助弹窗。
 *
 * 从 shared/shortcuts.ts 的单一事实源渲染全量快捷键，按「全局 / 标签页 / 窗格 /
 * 终端」分组。键位文案随平台（mac 用符号、其余用 Ctrl/Alt/Shift）自动切换。
 */

import {
  SHORTCUT_GROUPS,
  SHORTCUT_GROUP_LABEL_KEYS,
  shortcutsByGroup,
  displayAccelerator,
} from '@shared/shortcuts';
import { useUiStore } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useT } from '../i18n';
import { isMac } from '../platform';
import { IconClose, IconKeyboard } from './icons';
import { Modal } from './Modal';

export function ShortcutHelpDialog() {
  const t = useT();
  const close = useUiStore((s) => s.closeShortcutHelp);
  const overrides = useSettingsStore((s) => s.settings.shortcuts);

  return (
    <Modal
      overlayClassName="shortcut-help-overlay"
      dialogClassName="shortcut-help-dialog"
      ariaLabel={t('shortcuts.title')}
      onOverlayMouseDown={close}
      onClose={close}
    >
      <header className="shortcut-help-dialog__header">
        <span className="shortcut-help-dialog__icon" aria-hidden="true">
          <IconKeyboard size={18} />
        </span>
        <h2 className="shortcut-help-dialog__title">{t('shortcuts.title')}</h2>
        <button
          type="button"
          className="shortcut-help-dialog__close"
          onClick={close}
          title={t('common.close')}
          aria-label={t('common.close')}
        >
          <IconClose size={15} />
        </button>
      </header>

      <div className="shortcut-help-dialog__body">
        <div className="shortcut-help-dialog__body-inner">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group} className="shortcut-help-group">
              <h3 className="shortcut-help-group__title">{t(SHORTCUT_GROUP_LABEL_KEYS[group])}</h3>
              <ul className="shortcut-help-group__list">
                {shortcutsByGroup(group).map((def) => (
                  <li key={def.action} className="shortcut-help-row">
                    <span className="shortcut-help-row__label">{t(def.labelKey)}</span>
                    <kbd className="shortcut-key">{displayAccelerator(def, isMac, overrides)}</kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </Modal>
  );
}
