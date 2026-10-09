/**
 * ConfirmDialog —— 应用内确认对话框，替代原生 `confirm()`。
 *
 * 与设置弹窗同风格：遮罩 + 居中卡片。文案由调用方传入（已本地化），
 * 因此无需在这里维护 i18n key。
 */

import { useUiStore } from '../stores/uiStore';
import { useT } from '../i18n';
import { Modal } from './Modal';

export function ConfirmDialog() {
  const t = useT();
  const confirm = useUiStore((s) => s.confirm);
  const closeConfirm = useUiStore((s) => s.closeConfirm);

  if (!confirm) return null;

  const confirmLabel = confirm.confirmLabel ?? t('common.confirm');
  const cancelLabel = confirm.cancelLabel ?? t('common.cancel');

  const handleConfirm = () => {
    confirm.onConfirm();
    closeConfirm();
  };

  /**
   * 取消（取消按钮 / Esc / 点击遮罩）走同一条路径：
   * 先通知调用方，再关闭弹窗。
   */
  const handleCancel = () => {
    confirm.onCancel?.();
    closeConfirm();
  };

  return (
    <Modal
      overlayClassName="confirm-overlay"
      dialogClassName="confirm-dialog"
      role="alertdialog"
      ariaLabel={confirm.title}
      onOverlayMouseDown={handleCancel}
      onClose={handleCancel}
    >
      <h2 className="confirm-dialog__title">{confirm.title}</h2>
      {confirm.message && <p className="confirm-dialog__message">{confirm.message}</p>}
      <div className="confirm-dialog__actions">
        <button type="button" className="button" onClick={handleCancel}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className="button button--danger"
          onClick={handleConfirm}
          autoFocus
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
