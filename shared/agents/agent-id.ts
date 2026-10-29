/**
 * 智能体标识 —— 消灭 stringly-typed 的 agent id。
 *
 * 重构前，同一个智能体的名字散在 8 张表里（识别表 25 条 / manifest 22 条 /
 * 恢复白名单 19 条 / 恢复命令 18 条 / 集成 19 条 / 版本 19 条 / 脚本联合 13 条 /
 * 渲染端预设 26 条），成员各不相同且没有一处校验一致性。
 *
 * 这里只保留**一个** canonical 集合：声明顺序即「识别优先级」（见检测层的
 * first-match 语义），不要重排。
 */

/**
 * 所有可识别的智能体。
 *
 * 顺序与重构前的 `AGENT_IDENTITY` 完全一致 —— `detectAgentName` 按声明顺序
 * 取第一条命中的规则，重排会改变识别结果。
 */
export const AGENT_IDS = [
  'pi',
  'claude',
  'codex',
  'gemini',
  'cursor',
  'devin',
  'antigravity',
  'cline',
  'omp',
  'mastracode',
  'opencode',
  'copilot',
  'kimi',
  'kiro',
  'droid',
  'amp',
  'grok',
  'hermes',
  'kilo',
  'qodercli',
  'qwen',
  'letta',
  'maki',
  'muse',
  'dsh',
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

/** 普通终端预设的 id —— 不是智能体，只是「开一个 shell」。 */
export const TERMINAL_PRESET_ID = 'terminal';

const AGENT_ID_SET: ReadonlySet<string> = new Set(AGENT_IDS);

/** 是否是已知的智能体 id。 */
export function isAgentId(value: string | null | undefined): value is AgentId {
  return value != null && AGENT_ID_SET.has(value);
}

/**
 * 本项目对外标识符的统一前缀。
 *
 * 上游 herdr 也用裸 `herdr` 作前缀（`HERDR_PANE_ID`、`herdr:<agent>`、`herdr` 配置块），
 * 两者可能装在同一台机器上，所以本项目一律用 `herdr-desktop`（见 AGENTS.md 命名空间规则）。
 *
 * 不保留旧前缀兼容：本项目尚未发布，旧前缀只存在于开发期数据里，
 * 继续兼容会让「到底哪个前缀是权威」长期含糊。
 */
export const NAMESPACE = 'herdr-desktop';

/**
 * 官方集成上报来源，形如 `herdr-desktop:<agent>`。
 *
 * 集成脚本据此声明「我是谁上报的」，恢复侧只接受官方来源。
 */
export function agentSource(id: AgentId): string {
  return `${NAMESPACE}:${id}`;
}

/** 从来源串取出 agent 部分（非官方来源返回 null）。 */
export function agentIdFromSource(source: string): string | null {
  const prefix = `${NAMESPACE}:`;
  if (!source.startsWith(prefix)) return null;
  const id = source.slice(prefix.length);
  return id.length > 0 ? id : null;
}
