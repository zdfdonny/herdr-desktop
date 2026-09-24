/**
 * StatusDot —— agent 状态指示点。
 */

import type { AgentStatus } from '@shared/state';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n/messages';

const STATUS_KEY: Record<AgentStatus, MessageKey> = {
  idle: 'status.idle',
  working: 'status.working',
  blocked: 'status.blocked',
  done: 'status.done',
  unknown: 'status.unknown',
};

const STATUS_VAR: Record<AgentStatus, string> = {
  idle: 'var(--status-idle)',
  working: 'var(--status-working)',
  blocked: 'var(--status-blocked)',
  done: 'var(--status-done)',
  unknown: 'var(--status-unknown)',
};

export function StatusDot({ status, size = 8 }: { status: AgentStatus; size?: number }) {
  const t = useT();
  const label = t(STATUS_KEY[status]);
  return (
    <span
      className={`status-dot status-dot--${status}`}
      style={{ backgroundColor: STATUS_VAR[status], width: size, height: size }}
      title={label}
      aria-label={label}
    />
  );
}

export { STATUS_VAR };
