/**
 * ShortcutSettingRow —— 设置页里的单个可编辑快捷键行。
 *
 * 点击键位徽标进入捕获态：期间主进程忽略菜单快捷键（否则已注册的菜单
 * accelerator 会先于渲染层 keydown 被消费），下一个有效组合键即提交；
 * Esc 取消；不安全 / 冲突的组合键给出内联错误。有自定义覆盖时显示重置按钮。
 */

import { useEffect, useState } from 'react';
import type { ShortcutActionId, ShortcutDefinition, ShortcutOverrides } from '@shared/shortcuts';
import { SHORTCUTS, displayAccelerator } from '@shared/shortcuts';
import { useT } from '../i18n';
import { isMac } from '../platform';
import { useUiStore } from '../stores/uiStore';
import { beginShortcutCapture, endShortcutCapture } from '../ipc/client';
import { eventToAccelerator, validateShortcut } from '../shortcuts/capture';
import { IconClose } from './icons';

interface Props {
  def: ShortcutDefinition;
  overrides: ShortcutOverrides | undefined;
  onCommit: (action: ShortcutActionId, accelerator: string) => void;
  onReset: (action: ShortcutActionId) => void;
}

export function ShortcutSettingRow({ def, overrides, onCommit, onReset }: Props) {
  const t = useT();
  const setShortcutCapturing = useUiStore((s) => s.setShortcutCapturing);
  const overridden = overrides?.[def.action] != null;
  const [capturing, setCapturing] = useState(false);
  /** 已渲染的错误文案（冲突时包含冲突动作名）。 */
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!capturing) return;

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setCapturing(false);
        return;
      }

      const accelerator = eventToAccelerator(e);
      if (!accelerator) return; // 纯修饰键，继续等待

      const result = validateShortcut(def.action, accelerator, overrides);
      if (result.ok) {
        setCapturing(false);
        onCommit(def.action, accelerator);
        return;
      }

      if (result.reason === 'unsafe') {
        setError(t('shortcuts.unsafe'));
      } else {
        const conflictDef = SHORTCUTS.find((s) => s.action === result.conflictAction);
        setError(t('shortcuts.conflict', { name: conflictDef ? t(conflictDef.labelKey) : result.conflictAction }));
      }
      setCapturing(false);
    };

    // capture 阶段监听，先于 SettingsDialog 的冒泡 Esc 关闭处理执行。
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      setShortcutCapturing(false);
      endShortcutCapture();
    };
    // 只依赖 capturing：进入/退出捕获时重新绑定即可，闭包捕获当前值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing]);

  const startCapture = () => {
    setError(null);
    setShortcutCapturing(true);
    beginShortcutCapture();
    setCapturing(true);
  };

  return (
    <div className="shortcut-setting">
      <span className="shortcut-setting__label">{t(def.labelKey)}</span>
      <div className="shortcut-setting__control">
        {error && (
          <span className="shortcut-setting__error" role="alert">
            {error}
          </span>
        )}
        <button
          type="button"
          className={`shortcut-key shortcut-key--editable${capturing ? ' shortcut-key--capturing' : ''}${
            overridden && !capturing ? ' shortcut-key--overridden' : ''
          }`}
          onClick={startCapture}
          title={t('shortcuts.editHint')}
        >
          {capturing ? t('shortcuts.captureHint') : displayAccelerator(def, isMac, overrides)}
        </button>
        {overridden && !capturing && (
          <button
            type="button"
            className="shortcut-setting__reset"
            onClick={() => {
              setError(null);
              onReset(def.action);
            }}
            title={t('shortcuts.reset')}
            aria-label={t('shortcuts.reset')}
          >
            <IconClose size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
