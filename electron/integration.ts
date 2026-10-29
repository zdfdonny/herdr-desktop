/**
 * 集成安装的汇总层 —— **只做登记，不含实现**。
 *
 * 每个智能体的安装器（含它的资产、配置协议、Target 创建代码）都在
 * `electron/agents/integration/` 下自己的文件里：
 * - 声明式智能体：`declarative/<id>.ts`（layout 在 descriptor 里，资产自己 import）
 * - 特殊协议智能体：`<id>-installer.ts`（codex / kimi / antigravity / grok / hermes / dsh）
 * - 扩展与插件：`pi-installer.ts` / `omp-installer.ts` / `kilo-installer.ts` / `opencode-installer.ts`
 *
 * 本文件只把它们装配成一张表，并提供 `hookStatuses` / `installHook` / `uninstallHook`
 * 三个对外入口（router 与设置页只认这三个）。
 */

import { readFileSync } from 'node:fs';
import type { HookStatus } from '../shared/protocol';
import type { IntegrationInstaller } from './agents/installer';
import { createAllInstallers } from './agents/installer-factories';
import { installerFor, registerInstaller } from './agents/registry';

/**
 * 全部安装器 —— **惰性构造**。
 *
 * 构造时会读到各智能体的事件表与资产，其中一些定义在文件靠后的位置；
 * 模块顶层直接求值会撞上 TDZ。改成首次访问时构造，也避免应用启动时无谓地跑一遍。
 */
let hookTargetsCache: Record<string, IntegrationInstaller> | null = null;

function hookTargets(): Record<string, IntegrationInstaller> {
  if (hookTargetsCache !== null) return hookTargetsCache;
  hookTargetsCache = buildHookTargets();
  return hookTargetsCache;
}

/**
 * 构造全部安装器。
 *
 * 具体有哪些智能体、各自的工厂是谁，全在 `electron/agents/installer-factories.ts`
 * 那张表里 —— 本文件不再需要知道任何一个智能体的名字。
 */
function buildHookTargets(): Record<string, IntegrationInstaller> {
  return createAllInstallers();
}

/*
 * 把安装器登记到智能体运行时注册表。
 *
 * 业务代码（router / 设置页）此后只需 `installerFor(agentId)`。
 * 同样必须惰性 —— 模块加载期就构造会让上面那些事件表撞 TDZ。
 */
let installersRegistered = false;
function ensureInstallersRegistered(): void {
  if (installersRegistered) return;
  installersRegistered = true;
  for (const [agentId, installer] of Object.entries(hookTargets())) {
    registerInstaller(agentId, installer);
  }
}

/**
 * 单个智能体集成的安装状态。
 *
 * 通用逻辑只有三步（安装产物 → 读版本 → 比较），智能体私有的「装好了但已失效」
 * 判据通过 `validate` 挂在实现自己身上。
 */
export function hookStatuses(): Record<string, HookStatus> {
  ensureInstallersRegistered();
  const result: Record<string, HookStatus> = {};
  for (const [id, target] of Object.entries(hookTargets())) {
    if (!target.isInstalled()) {
      result[id] = 'not-installed';
      continue;
    }
    const expected = target.version();
    const version = readInstalledVersion(target.artifactPath());
    if (expected !== null && version !== null && version < expected) {
      result[id] = 'outdated';
      continue;
    }
    // 产物存在、版本也够，但智能体私有的一致性校验不过（配置漂移 / 注册失效）。
    result[id] = target.validate?.() === false ? 'outdated' : 'installed';
  }
  return result;
}

/** 读取已安装资产里的版本标记；读不到时返回 null。 */
function readInstalledVersion(path: string | null): number | null {
  if (!path) return null;
  try {
    const content = readFileSync(path, 'utf8');
    const match = content.match(/HERDR_DESKTOP_INTEGRATION_VERSION=(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * 安装（或更新）某个智能体的集成。
 *
 * 走注册表而不是直接查本地表：业务侧只认识「智能体 id → 安装器」这一层能力。
 * 返回安装后的状态：只反映产物是否存在，权威状态由 `hookStatuses()` 给出
 * （它还要比版本、跑 validate）。
 */
export async function installHook(agentId: string): Promise<HookStatus> {
  ensureInstallersRegistered();
  const installer = installerFor(agentId);
  if (!installer) return 'unsupported';
  await installer.install();
  return installer.isInstalled() ? 'installed' : 'not-installed';
}

/** 卸载某个智能体的集成（幂等）。 */
export async function uninstallHook(agentId: string): Promise<HookStatus> {
  ensureInstallersRegistered();
  const installer = installerFor(agentId);
  if (!installer) return 'unsupported';
  await installer.uninstall();
  return installer.isInstalled() ? 'installed' : 'not-installed';
}
