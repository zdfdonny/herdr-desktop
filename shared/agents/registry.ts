/**
 * 智能体注册表 —— 主进程与渲染进程共用的唯一真源。
 *
 * 重构前，「哪些智能体存在」有 8 份互不相同的答案（识别 25 / manifest 22 /
 * 恢复白名单 19 / 恢复命令 18 / 集成 19 / 版本 19 / 脚本联合 13 / 渲染端预设 26），
 * 且没有任何一处校验它们一致 —— 每张表缺一条都会以不同方式静默降级。
 * 现在只剩这一个。
 */

import type { AgentId } from './agent-id';
import { isAgentId } from './agent-id';
import type { AgentDescriptor } from './descriptor';
import { DESCRIPTORS } from './descriptors';

const BY_ID = new Map<string, AgentDescriptor>(DESCRIPTORS.map((d) => [d.id, d]));

/**
 * 按**识别优先级**排序后的描述符（数字小的先匹配）。
 *
 * 为什么要有这一层：识别是 first-match —— `detectAgentName` 逐条试
 * `detection.identity`，第一个命中的就是答案。优先级若隐含在 `DESCRIPTORS`
 * 数组的位置里，新增智能体时「插到哪一行」会悄悄改变其它智能体的识别结果。
 *
 * 显式 `detectionPriority` + 这里的排序，让优先级成为**智能体自己的声明**：
 * 新增时只需给一个数字，插到数组哪里都不影响别人。
 *
 * 相同 priority 时按 id 字典序 —— 用显式比较而不是依赖 `Array.prototype.sort`
 * 的稳定性，保证任何 JS 引擎下结果一致。
 */
const BY_PRIORITY: readonly AgentDescriptor[] = [...DESCRIPTORS].sort(
  (a, b) => a.detectionPriority - b.detectionPriority || a.id.localeCompare(b.id),
);

/**
 * 按 id 取描述符。
 *
 * 未知 id 返回 null（不做兜底猜测：调用方必须显式决定「不认识时怎么办」，
 * 这正是重构前靠 `string` 类型回避掉的问题）。
 */
export function agentById(id: string | null | undefined): AgentDescriptor | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

/**
 * 全部描述符，**按识别优先级排序**（数字小的在前）。
 *
 * 顺序敏感的地方（识别、别名归一）必须用它而不是 `DESCRIPTORS`，
 * 这样 `DESCRIPTORS` 数组的书写顺序就只是「import 清单」，不再承载语义。
 */
export function allAgents(): readonly AgentDescriptor[] {
  return BY_PRIORITY;
}

/** 支持官方集成的智能体（有 integration 声明）。 */
export function integrableAgents(): readonly AgentDescriptor[] {
  return DESCRIPTORS.filter((d) => d.integration !== undefined);
}

/** 支持会话恢复的智能体。 */
export function resumableAgents(): readonly AgentDescriptor[] {
  return DESCRIPTORS.filter((d) => d.resume !== undefined);
}

/** 有屏幕检测规则的智能体。 */
export function detectableAgents(): readonly AgentDescriptor[] {
  return DESCRIPTORS.filter((d) => d.detection?.manifest !== undefined);
}

/** 全部 web 型智能体（宿主形态为内嵌 Web GUI）。 */
export function webAgents(): readonly AgentDescriptor[] {
  return DESCRIPTORS.filter((d) => d.hosting === 'web');
}

/**
 * 解析「要创建哪个 web 型智能体」。
 *
 * `requested` 缺省（旧渲染端只传 projectId）时回退到唯一的 web 型智能体；
 * 一旦将来有多个，缺省值会变成歧义 —— 那时应当让调用方显式指定，
 * 这里返回 null 而不是随便猜一个。
 */
export function resolveWebAgent(requested?: string | null): AgentDescriptor | null {
  if (requested) {
    const agent = agentById(requested);
    return agent?.hosting === 'web' ? agent : null;
  }
  const candidates = webAgents();
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * 别名归一化表：别名 → canonical id。
 *
 * 由各 descriptor 的 `detection.aliases` 汇总而来，因此新增智能体时
 * 别名与识别规则写在同一处，不会再出现「加了 agent 忘了加别名」。
 */
const ALIAS_TO_ID = new Map<string, AgentId>();
for (const descriptor of BY_PRIORITY) {
  for (const alias of descriptor.detection?.aliases ?? []) {
    // 先写者优先：同一别名被两个 agent 声明时保留靠前（= 识别优先级更高）的那个。
    if (!ALIAS_TO_ID.has(alias)) ALIAS_TO_ID.set(alias, descriptor.id);
  }
}

/** 按别名查 canonical id（未登记返回 null）。 */
export function agentIdForAlias(alias: string): AgentId | null {
  return ALIAS_TO_ID.get(alias) ?? null;
}

/** 规范化后的名字 → canonical id：先看 id 本身，再看别名。 */
export function resolveAgentId(name: string): AgentId | null {
  if (isAgentId(name)) return name;
  return agentIdForAlias(name);
}
