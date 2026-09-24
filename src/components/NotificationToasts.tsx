/**
 * NotificationToasts —— 右下角的错误/提示浮层。
 *
 * 通知内部保存的是文案 key，渲染时按当前语言翻译，
 * 因此切换语言后已存在的通知也会同步更新。
 */

import { useEffect } from 'react';
import { useNotificationStore, type AppNotification } from '../stores/notificationStore';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n/messages';

const AUTO_DISMISS_MS = 8000;

/** Main 进程给的 key 是宽松字符串，此处安全地转为已知 key。 */
function asKey(value: string | undefined): MessageKey | null {
  return value ? (value as MessageKey) : null;
}

export function NotificationToasts() {
  const notifications = useNotificationStore((s) => s.notifications);

  if (notifications.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {notifications.map((n) => (
        <Toast key={n.id} notification={n} />
      ))}
    </div>
  );
}

function Toast({ notification }: { notification: AppNotification }) {
  const t = useT();
  const dismiss = useNotificationStore((s) => s.dismiss);

  useEffect(() => {
    const timer = setTimeout(() => dismiss(notification.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [notification.id, dismiss]);

  // 已知 key 走翻译；未知 key（如 Main 直接给的原始错误文本）原样展示
  const titleKey = asKey(notification.titleKey);
  const detailKey = asKey(notification.detailKey);
  const title = titleKey ? t(titleKey, notification.titleVars) : notification.titleKey;
  const detail = detailKey ? t(detailKey, notification.detailVars) : undefined;

  return (
    <div className={`toast toast--${notification.kind}`}>
      <div className="toast__body">
        <div className="toast__title">{title}</div>
        {detail && <div className="toast__detail">{detail}</div>}
        {notification.titleVars?.reason && (
          <div className="toast__detail">{String(notification.titleVars.reason)}</div>
        )}
      </div>
      <button
        type="button"
        className="toast__close"
        onClick={() => dismiss(notification.id)}
        aria-label={t('error.dismiss')}
      >
        ×
      </button>
    </div>
  );
}
