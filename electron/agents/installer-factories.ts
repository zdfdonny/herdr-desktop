/**
 * 集成安装器工厂注册表。
 *
 * 这里**只有一张 id → 工厂 的表**，不含任何实现：
 * 每个智能体的 `createXxxTarget()` 都在它自己的文件里（资产、配置协议、
 * 路径解析一并带着），本文件只负责把 id 和工厂对上号。
 *
 * 为什么是「显式清单」而不是「模块加载时自注册」：
 * - 自注册依赖 import 副作用，某个模块被 tree-shaking 或漏 import 时会**静默丢失**
 *   一个智能体，而失败点离原因很远；
 * - 显式清单漏了就是类型错误（`Record<AgentId, ...>` 缺键会报错）。
 * 这与 `shared/agents/descriptors/index.ts` 的 `DESCRIPTORS` 数组是同一个取舍。
 *
 * 新增一个带官方集成的智能体：
 * 1. 在它自己的文件里写 `createXxxTarget()`；
 * 2. 在下面这张表里加一行。
 * `electron/runtime/integration/index.ts` 不需要改。
 */

import type { AgentId } from '../../shared/agents/agent-id';
import type { IntegrationInstaller } from './installer';

import { createAntigravityTarget } from './installers/antigravity-installer';
import { createClaudeTarget } from './installers/declarative/claude';
import { createCopilotTarget } from './installers/declarative/copilot';
import { createCursorTarget } from './installers/declarative/cursor';
import { createDevinTarget } from './installers/declarative/devin';
import { createDroidTarget } from './installers/declarative/droid';
import { createLettaTarget } from './installers/declarative/letta';
import { createMastracodeTarget } from './installers/declarative/mastracode';
import { createQodercliTarget } from './installers/declarative/qodercli';
import { createQwenTarget } from './installers/declarative/qwen';
import { createCodexTarget } from './installers/codex-installer';
import { createDshTarget } from './installers/dsh-installer';
import { createGrokTarget } from './installers/grok-installer';
import { createHermesTarget } from './installers/hermes-installer';
import { createKiloTarget } from './installers/kilo-installer';
import { createKimiTarget } from './installers/kimi-installer';
import { createOmpTarget } from './installers/omp-installer';
import { createOpencodeTarget } from './installers/opencode-installer';
import { createPiTarget } from './installers/pi-installer';

/** 造一个安装器（每次调用都应当返回新实例，便于重复构造与测试）。 */
export type InstallerFactory = () => IntegrationInstaller;

/**
 * 有官方集成的智能体 → 工厂。
 *
 * 类型用 `Partial<Record<AgentId, ...>>` 而不是 `Record<AgentId, ...>`：
 * 有些智能体只有检测规则、没有官方集成（如 `detection-only` 里那批），
 * 强制要求 19+6 条会逼出 6 个空实现。
 */
export const INSTALLER_FACTORIES: Readonly<Partial<Record<AgentId, InstallerFactory>>> = {
  claude: createClaudeTarget,
  codex: createCodexTarget,
  kimi: createKimiTarget,
  copilot: createCopilotTarget,
  devin: createDevinTarget,
  droid: createDroidTarget,
  qodercli: createQodercliTarget,
  qwen: createQwenTarget,
  letta: createLettaTarget,
  cursor: createCursorTarget,
  mastracode: createMastracodeTarget,
  antigravity: createAntigravityTarget,
  grok: createGrokTarget,
  pi: createPiTarget,
  omp: createOmpTarget,
  opencode: createOpencodeTarget,
  kilo: createKiloTarget,
  hermes: createHermesTarget,
  dsh: createDshTarget,
};

/** 按 id 取工厂（无则该智能体不支持官方集成）。 */
export function installerFactoryFor(agentId: string | null | undefined): InstallerFactory | null {
  if (!agentId) return null;
  const factory = INSTALLER_FACTORIES[agentId as AgentId];
  return factory ?? null;
}

/** 全部「id + 工厂」条目（顺序稳定，便于断言与展示）。 */
export function allInstallerFactories(): Array<[string, InstallerFactory]> {
  return Object.entries(INSTALLER_FACTORIES).filter(
    (entry): entry is [string, InstallerFactory] => typeof entry[1] === 'function',
  );
}

/** 构造全部安装器。 */
export function createAllInstallers(): Record<string, IntegrationInstaller> {
  const targets: Record<string, IntegrationInstaller> = {};
  for (const [agentId, factory] of allInstallerFactories()) {
    targets[agentId] = factory();
  }
  return targets;
}
