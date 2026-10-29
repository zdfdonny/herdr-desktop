/**
 * hook 权威载体 —— 「这个 pane 现在的状态是哪个来源报的、报了什么」。
 *
 * 从 `terminal-state.ts` 移到 `state/` 下，供协作对象（仲裁、抑制账本）共用，
 * 避免它们反向 import 状态机造成循环依赖。
 */

import type { DetectedState } from '../../../../shared/state';
import type { AgentSessionRef } from './agent-session-ref';

export interface HookAuthority {
  source: string;
  agentLabel: string;
  state: DetectedState;
  message: string | null;
  reportedAt: number;
  sessionRef: AgentSessionRef | null;
}
