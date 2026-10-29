/**
 * 智能体运行时注册表 —— 「智能体 id → 主进程实现」的单一出口。
 *
 * 分层：
 * - `shared/agents/registry.ts`：智能体的**静态事实**（descriptor），主/渲染共用；
 * - 本文件：智能体的**主进程实现**（集成安装器）。需要 fs / 进程能力的东西放这里。
 *
 * 这样业务代码只需要问一句「这个智能体的安装器是什么」，
 * 不必知道 19 个工厂函数各自怎么拼配置路径。
 */

import type { AgentId } from '../../shared/agents/agent-id';
import { agentById } from '../../shared/agents/registry';
import type { AgentDescriptor } from '../../shared/agents/descriptor';
import type { IntegrationInstaller } from './installer';

/** 一个智能体的主进程实现。 */
export interface AgentRuntime {
  readonly descriptor: AgentDescriptor;
  /** 集成安装器；null = 该智能体不支持官方集成。 */
  readonly installer: IntegrationInstaller | null;
}

/** 安装器注册表（由 `electron/runtime/integration` 在加载时填充）。 */
const installers = new Map<string, IntegrationInstaller>();

/** 登记某个智能体的安装器（供集成模块自注册）。 */
export function registerInstaller(agentId: string, installer: IntegrationInstaller): void {
  installers.set(agentId, installer);
}

/** 取某个智能体的安装器（无则 null）。 */
export function installerFor(agentId: string | null | undefined): IntegrationInstaller | null {
  if (!agentId) return null;
  return installers.get(agentId) ?? null;
}

/** 取某个智能体的运行时实现（descriptor + 安装器）。 */
export function agentRuntime(agentId: string | null | undefined): AgentRuntime | null {
  const descriptor = agentById(agentId);
  if (!descriptor) return null;
  return { descriptor, installer: installerFor(descriptor.id) };
}

/** 全部已登记安装器的智能体 id。 */
export function installedRuntimeIds(): AgentId[] {
  return [...installers.keys()] as AgentId[];
}
