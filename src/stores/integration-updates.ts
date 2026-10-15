/**
 * 集成更新判据 —— 纯逻辑，便于独立测试（npm run test:integrations）。
 *
 * 侧栏「集成」按钮的待更新数量、以及「一键安装」的目标筛选都基于这里，
 * 因此刻意不依赖 React / store / IPC：状态表由调用方传入。
 */

import type { HookStatus } from '@shared/protocol';

/** 各智能体的集成安装状态表（agentId → 状态）。 */
export type HookStatusMap = Record<string, HookStatus>;

/**
 * 待更新的集成数量（侧栏「集成」按钮计数徽标上的数字）。
 *
 * 只有「本机可用且 `outdated`（已集成但版本旧）」才算「更新」：
 * - `not-installed`：还没集成，属于首次安装，不计数；
 * - `unsupported`：官方暂无该智能体的集成，永远不会变成可更新；
 * - `installed`：已是最新。
 *
 * 为什么要判可用性：Main 的 `outdated` 只看 hook 文件里的版本标记
 * （`isInstalled()` = 脚本文件是否存在），与智能体是否还在本机无关。
 * 若某个装过集成的智能体之后从本机消失（卸载 CLI / PATH 变化），集成页
 * 那一行只显示「未找到」、没有任何按钮，一键安装也会跳过它，计数却仍
 * 大于 0 —— 徽标就再也清不掉了，违反「更新全部完成后徽标消失」。
 * 这里与 `installableAgentIds` 共用同一个可用性判据，保证返回值等于
 * 集成页里能点的「更新」按钮个数。
 *
 * @param isAgentAvailable 判断某个 agentId 是否在本机可用。由调用方注入，
 *                         避免纯模块反向依赖 agentsStore（可用性探测）；
 *                         未探测完成时应返回 true（与 isAvailable 一致）。
 */
export function countIntegrationUpdates(
  statuses: HookStatusMap,
  isAgentAvailable: (agentId: string) => boolean,
): number {
  return Object.entries(statuses).filter(
    ([agentId, status]) => status === 'outdated' && isAgentAvailable(agentId),
  ).length;
}

/**
 * 「一键安装」的目标列表：只给**本机存在该 CLI** 的智能体装集成。
 *
 * 判据只有「CLI 在不在本机」，与集成装没装无关：`not-installed`（CLI 在、
 * 集成还没装）正是要装的主要目标，CLI 不在本机的不碰（装了也没用）。
 *
 * @param agentIds agentId → 集成状态。只用键（有哪些智能体）。
 * @param isAgentAvailable 判断某个 agentId 是否在本机可用。由调用方注入，
 *                         避免纯模块反向依赖 agentsStore（可用性探测）。
 */
export function installableAgentIds(
  agentIds: HookStatusMap,
  isAgentAvailable: (agentId: string) => boolean,
): string[] {
  return Object.keys(agentIds).filter((agentId) => isAgentAvailable(agentId));
}
