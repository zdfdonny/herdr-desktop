/**
 * 会话引用的公共形状与比较。
 *
 * `AgentSessionRef` 原本重复定义在两处（`agent-resume.ts` 与 `terminal-state.ts`
 * 各自一份），比较函数也各写一遍。抽到这里，让状态机的协作对象可以直接复用，
 * 不必从 `terminal-state.ts` 反向引用（否则会形成循环依赖）。
 */

import type { AgentSessionRefKind } from '../../../../shared/state';

/** 会话引用（id 或文件路径）。 */
export interface AgentSessionRef {
  kind: AgentSessionRefKind;
  value: string;
}

/** 两个会话引用是否指向同一会话（null 只与 null 相等）。 */
export function sessionRefEquals(
  a: AgentSessionRef | null,
  b: AgentSessionRef | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.kind === b.kind && a.value === b.value;
}
