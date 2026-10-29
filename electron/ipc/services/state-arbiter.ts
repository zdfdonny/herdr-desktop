/**
 * 状态仲裁的**判定规则**（R2）。
 *
 * 从 `IpcRouter` 抽出的是「怎么判」，不是「怎么改」：
 * - `arbitrateState` 仍然留在 router 里做编排（它要动终端状态机与会话）；
 * - 但其中的两条判据是纯逻辑，且是最容易出错、最需要被逐条断言的部分，
 *   放到这里以便脱离 Electron 单测。
 *
 * 这两条规则回答同一个问题的两半：
 * 「屏幕观测到一个『完成』跳变时，这个完成该由谁来认？」
 */

import type { EffectiveStateChange } from '../../runtime/terminal/state/terminal-types';
import { isCompletionTransition } from '../../../shared/agents/status';

/** 会话层投影后的跳变（`to` 是 AgentStatus，不是 DetectedState）。 */
export interface ProjectedTransition {
  from: string;
  to: string;
}

/**
 * 屏幕观测是否产出了一个「完成」跳变。
 *
 * 注意用的是**原始状态**（`EffectiveStateChange.previousState → state`），
 * 不是投影后的 `AgentStatus` —— 投影会把「未聚焦 pane 的完成」显示成 `done`，
 * 两者含义不同，混用会导致后台 pane 的抑制规则失效。
 */
export function screenReportsCompletion(change: EffectiveStateChange | null): boolean {
  if (change === null) return false;
  return isCompletionTransition(change.previousState, change.state);
}

/**
 * 是否应当**抑制**屏幕判出的这个完成（不通知、也不置 done 徽标）。
 *
 * 抑制成立需要两个条件同时满足：
 * 1. 该智能体的完成判定确实交给了 hook（`hooksOwnCompletion`）——
 *    没装集成时 hook 永远不会上报 idle，此时若仍抑制屏幕，这个 pane 就再也不会响
 *    完成提示音、也不会出现 done 徽标；
 * 2. 投影后的跳变确实是 working/blocked → idle/done。
 *
 * 第 2 条必须匹配 `idle` **和** `done`：`paneAgentStatus` 会把未聚焦 pane 的完成
 * 投影成 `done`，只匹配 `idle` 会让后台 pane 漏过抑制、照旧乱响。
 */
export function shouldSuppressScreenCompletion(
  transition: ProjectedTransition | null,
  hooksOwnCompletion: boolean,
): boolean {
  if (!hooksOwnCompletion || transition === null) return false;
  const projectedAsCompletion =
    (transition.to === 'idle' || transition.to === 'done') &&
    (transition.from === 'working' || transition.from === 'blocked');
  return projectedAsCompletion;
}

/**
 * 屏幕这次观测是否应当触发通知。
 *
 * 与 `shouldSuppressScreenCompletion` 互为反义，但语义不同：
 * 前者判断「要不要压掉完成」，这里判断「要不要发通知」——
 * blocked 通知不受完成归属影响，只有完成才受影响。
 */
export function shouldNotifyOnScreenTransition(
  transition: ProjectedTransition | null,
  hooksOwnCompletion: boolean,
): boolean {
  return !shouldSuppressScreenCompletion(transition, hooksOwnCompletion);
}
