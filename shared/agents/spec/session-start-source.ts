/**
 * 会话启动来源的合法取值 —— **单一真源**。
 *
 * 重构前这个枚举有两份：`agent-resume.ts` 的 `normalizeSessionStartSource`（8 个值，
 * 含 `branch`）与 `terminal-state.ts` 的 `sessionStartSourceIsRecognized`（7 个值，
 * **漏了 `branch`**）。后果是 qwen 白名单里的 `branch` 条目永远无法命中 ——
 * 同一个概念两处表示，已经产生了可复现的逻辑漏洞。
 */

/** 各 CLI 在会话启动时会上报的来源枚举（对应 herdr 的 session_start_source）。 */
export const SESSION_START_SOURCES = [
  'startup',
  'resume',
  'clear',
  'compact',
  'branch',
  'new',
  'fork',
  'select',
] as const;

export type SessionStartSource = (typeof SESSION_START_SOURCES)[number];

const SOURCE_SET: ReadonlySet<string> = new Set(SESSION_START_SOURCES);

/** 是否是已知的会话启动来源。 */
export function isSessionStartSource(value: string | null | undefined): value is SessionStartSource {
  return value != null && SOURCE_SET.has(value);
}

/** 规范化会话启动来源（对应 herdr `normalize_session_start_source`）；未知返回 null。 */
export function normalizeSessionStartSource(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && SOURCE_SET.has(trimmed) ? trimmed : null;
}
