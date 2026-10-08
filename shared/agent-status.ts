/**
 * agent 状态投影 —— 对应 herdr `src/app/api_helpers.rs` 与 `src/app/actions.rs`。
 *
 * 检测层 / hook 层只产出 4 值 DetectedState；`done` 由 `paneAgentStatus(state, seen)`
 * 派生，绝不落回检测层。这里的函数是纯函数，可无 PTY 单元测试。
 */

import type { AgentStatus, DetectedState } from './state';

/**
 * 把检测层的状态 + 是否已看投影为最终状态（对应 herdr `pane_agent_status`）。
 *
 * - idle + 未看 → done（后台完成、尚未被查看）；
 * - idle + 已看 → idle；
 * - working / blocked / unknown 原样透传。
 */
export function paneAgentStatus(state: DetectedState, seen: boolean): AgentStatus {
  switch (state) {
    case 'idle':
      return seen ? 'idle' : 'done';
    case 'working':
      return 'working';
    case 'blocked':
      return 'blocked';
    case 'unknown':
      return 'unknown';
  }
}

/**
 * 是否是一次「完成跳变」（对应 herdr `is_completion_transition`）：
 * 只有 working/blocked → idle 才算，unknown → idle 不算。
 */
export function isCompletionTransition(prev: DetectedState, next: DetectedState): boolean {
  return next === 'idle' && (prev === 'working' || prev === 'blocked');
}
