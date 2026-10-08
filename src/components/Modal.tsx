/**
 * Modal —— 统一的模态弹窗骨架。
 *
 * 职责：
 * - 遮罩 + 居中卡片（各弹窗通过 overlayClassName / dialogClassName 定制外观）；
 * - 挂载时注册「模态打开」，卸载时注销——标题栏据此把原生最小化/最大化/关闭
 *   按钮同步成遮罩压暗色（原生 titleBarOverlay 绘制在最上层，CSS 遮罩盖不住）；
 * - 可选 Esc 关闭（onClose）与点击遮罩关闭（onOverlayMouseDown）。
 *
 * 新增弹窗一律用本组件，避免每次都要重写遮罩与标题栏压暗逻辑。
 */

import { useEffect, type ReactNode } from 'react';
import { useUiStore } from '../stores/uiStore';

interface ModalProps {
  /** 遮罩层 class（如 settings-overlay / confirm-overlay）。 */
  overlayClassName: string;
  /** 对话框 class（如 settings-dialog / confirm-dialog）。 */
  dialogClassName: string;
  /** 对话框语义角色，默认 dialog；确认框用 alertdialog。 */
  role?: 'dialog' | 'alertdialog';
  /** 无障碍名称。 */
  ariaLabel?: string;
  /** 点击遮罩时回调（通常关闭）。缺省不处理。 */
  onOverlayMouseDown?: () => void;
  /** 提供时，Esc 触发 onClose。 */
  onClose?: () => void;
  children: ReactNode;
}

export function Modal({
  overlayClassName,
  dialogClassName,
  role = 'dialog',
  ariaLabel,
  onOverlayMouseDown,
  onClose,
  children,
}: ModalProps) {
  const openModal = useUiStore((s) => s.openModal);
  const closeModal = useUiStore((s) => s.closeModal);

  // 挂载即注册「有模态打开」，卸载注销。
  useEffect(() => {
    openModal();
    return closeModal;
  }, [openModal, closeModal]);

  // Esc 关闭（冒泡阶段；改键捕获在 capture 阶段 stopPropagation，不会触发这里）。
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={overlayClassName} role="presentation" onMouseDown={onOverlayMouseDown}>
      <div
        className={dialogClassName}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
