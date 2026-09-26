/**
 * 侧栏 agent 列表的显示名与排序。
 *
 * 抽成独立模块（而非留在 sessionStore 里）有两个原因：
 * 1. AgentRow 渲染时也要用同一个显示名——排序键必须等于用户看到的文字，
 *    否则列表看起来是乱的。共用一处实现才不会各自漂移。
 * 2. 便于单独测试排序规则（见 scripts/test-agent-sort.mjs）。
 */

import type { AgentState } from '@shared/state';

/** 排序与渲染共用的最小字段集。 */
type SortableAgent = Pick<AgentState, 'label' | 'name'> & { paneId: string };

/**
 * 侧栏 agent 行的显示名。
 *
 * 与 AgentRow 渲染时用的表达式保持一致——排序键必须等于用户看到的文字，
 * 否则列表看起来是乱的。
 */
export function agentDisplayName(agent: Pick<AgentState, 'label' | 'name'>): string {
  return agent.label ?? agent.name ?? 'agent';
}

/**
 * 显示名的字母序比较（排序规则的单一定义处）。
 *
 * 用 localeCompare 而非 `<`/`>`：直接比码点会把大写全排在小写前
 * （"Zed" 排在 "apple" 前），且无法正确处理数字与本地化字符。
 * `numeric` 让 "agent2" 排在 "agent10" 前，而不是按字典序反过来；
 * `sensitivity: 'base'` 让大小写/变音符号不参与比较（"Alpha" 与 "alpha" 视为同名）。
 */
export function compareAgentNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * agent 列表排序：按显示名字母序。
 *
 * 同名时回退到 paneId 保证**稳定**：否则名字相同的行会在每次快照
 * （状态刷新都会推快照）时因排序不稳定而互换位置，看着像在跳动。
 */
export function compareAgents(a: SortableAgent, b: SortableAgent): number {
  const byName = compareAgentNames(agentDisplayName(a), agentDisplayName(b));
  return byName !== 0 ? byName : a.paneId.localeCompare(b.paneId);
}
