/**
 * agent 检测层 —— 识别、别名归一、状态信号求值。
 *
 * 重构后这里只剩「怎么用」的逻辑：所有**关于某个智能体的知识**（识别正则、
 * 别名、屏幕规则、状态仲裁策略）都搬到了 `shared/agents/descriptors/`，
 * 由 `shared/agents/registry.ts` 汇总。对外函数签名保持不变（调用方零改动）。
 */

import { type AgentId, agentSource } from '../agents/agent-id';
import { agentById, allAgents, resolveAgentId } from '../agents/registry';
import { evaluateManifest, validateManifestRegions, type ManifestDetection } from './engine';
import { MANIFESTS } from './manifests';
import type { DetectedState } from '../state';

// 供测试直接校验 manifest 注册表与求值引擎
export { evaluateManifest, MANIFESTS };
export { allAgents, agentById };

/**
 * 把上报/检测到的 agent 标签归一化为 canonical 名（对应 herdr `parse_agent_label`）。
 *
 * 未知标签返回 null。desktop 的检测层直接产出 canonical 字符串，
 * 因此这里不像 herdr 那样返回枚举，而是返回 canonical 字符串本身。
 */
export function parseAgentLabel(label: string): string | null {
  return normalizedAgentId(label);
}

/** 归一化 + 查表，返回 `AgentId | null`（内部使用，比 string 更有信息量）。 */
export function normalizedAgentId(label: string): AgentId | null {
  return resolveAgentId(pathBasename(normalizedAgentLookupName(label)));
}

/** 对应 herdr `normalized_agent_lookup_name`：trim + 小写 + 去可执行后缀。 */
function normalizedAgentLookupName(name: string): string {
  let n = name.trim().toLowerCase();
  for (const suffix of ['.exe', '.cmd', '.bat', '.ps1', '.js']) {
    if (n.endsWith(suffix)) {
      n = n.slice(0, -suffix.length);
      break;
    }
  }
  return n;
}

/** 对应 herdr `path_basename`：取路径最后一段。 */
function pathBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/**
 * 完整生命周期 hook 权威（对应 herdr `full_lifecycle_hook_authority`）。
 *
 * 这些集成的 hook 活着时对状态拥有权威，屏幕检测只作回退。
 */
export function fullLifecycleHookAuthority(source: string, agentLabel: string): boolean {
  const descriptor = agentById(normalizedAgentId(agentLabel));
  return (
    descriptor !== null &&
    descriptor.policy.hookAuthority === 'full-lifecycle' &&
    source === agentSource(descriptor.id)
  );
}

/**
 * 仅上报会话身份的集成（对应 herdr `session_identity_only_integration`）。
 *
 * 这些来源不持有状态权威，只提供会话引用。
 */
export function sessionIdentityOnlyIntegration(source: string, agentLabel: string): boolean {
  const descriptor = agentById(normalizedAgentId(agentLabel));
  return (
    descriptor !== null &&
    descriptor.policy.hookAuthority === 'none' &&
    source === agentSource(descriptor.id)
  );
}

/**
 * 完成判定完全交给 hook 的 agent —— 屏幕不再决定「完成」。
 *
 * 往策略里加 agent 时必须确认它的集成确实会上报状态，否则它永远不会响完成提示音；
 * 这个前提由 `policy.completionRequiresIntegration` 兜住（调用方会额外要求集成已安装）。
 */
export function screenCompletionIgnored(agentLabel: string | null): boolean {
  if (!agentLabel) return false;
  const descriptor = agentById(normalizedAgentId(agentLabel));
  return descriptor !== null && !descriptor.policy.screenOwnsCompletion;
}

/**
 * 启动阶段「屏幕 working 一律不参与状态」的 agent —— 初始化不产生状态变化。
 */
export function screenStartupIgnored(agentLabel: string | null): boolean {
  if (!agentLabel) return false;
  const descriptor = agentById(normalizedAgentId(agentLabel));
  return descriptor !== null && descriptor.policy.ignoreStartupWorking;
}

/**
 * 检测并返回完整信号（state + visible_* + skip_state_update），
 * 对应 herdr 的 `detect_agent_with_osc`（返回 AgentDetection）。
 *
 * - 有专属 manifest 的 agent：visible_* 由命中规则的标志精确返回；
 * - 无 manifest 的 agent（omp / mastracode / dsh）：对应 herdr fallback_explain ——
 *   已知 agent 回落 idle、未知 agent 回落 unknown，**不做屏幕关键词猜测**
 *   （没有 manifest 就没有可靠的屏幕证据，状态交给 hook 权威）。
 */
export function detectWithSignals(
  agentName: string | null,
  snapshot: string,
  oscTitle = '',
  oscProgress = '',
): ManifestDetection {
  const descriptor = agentById(agentName);
  const manifest = descriptor?.detection?.manifest ?? (agentName ? MANIFESTS[agentName] : undefined);
  if (manifest) {
    return evaluateManifest(
      manifest,
      { screen: snapshot, oscTitle, oscProgress },
      descriptor?.detection?.regions,
    );
  }

  // fallback（对应 herdr fallback_explain）：已知 agent → idle，未知 → unknown。
  const state: DetectedState = agentName ? 'idle' : 'unknown';
  return {
    state,
    visibleIdle: false,
    visibleBlocker: false,
    visibleWorking: false,
    skipStateUpdate: false,
  };
}

/**
 * 从一段终端快照文本 + 已识别 agent 名推断状态（只返回状态，忽略 visible 信号）。
 *
 * 输入应来自底部缓冲（见 agent-detector 的 bottomBuffer）。
 */
export function detectStatus(
  agentName: string | null,
  snapshot: string,
  oscTitle = '',
  oscProgress = '',
): DetectedState {
  return detectWithSignals(agentName, snapshot, oscTitle, oscProgress).state;
}

/**
 * 从终端标题/快照中粗略识别 agent 名。
 *
 * 按注册表声明顺序取第一条命中的识别规则 —— 顺序即优先级，
 * 与重构前 `AGENT_IDENTITY` 的线性扫描语义一致。
 */
export function detectAgentName(snapshot: string): string | null {
  const lower = snapshot.toLowerCase();
  for (const descriptor of allAgents()) {
    const identity = descriptor.detection?.identity;
    if (identity && new RegExp(identity, 'i').test(lower)) {
      return descriptor.id;
    }
  }
  return null;
}

/**
 * 会话 id 识别模式（采集端 fallback）。
 *
 * 权威来源是官方 hook 上报（`agent:report-session`）；这里只兜底识别那些
 * 会在终端输出里显式打印会话标识的形态。为降低误报，只接受：
 * - `session[:= ]? <uuid>` 这种带明确关键词的形态；
 * - DSH 式自描述 token `session-<id>`。
 * 不接受裸 UUID（在日志里太常见，容易把随机内容误当成会话 id）。
 */
const SESSION_ID_PATTERNS: RegExp[] = [
  /\bsession(?:\s+id)?\s*[:=]\s*['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]?/i,
  /\bsession\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
  /\b(session-[a-z0-9_-]{8,})\b/i,
];

/**
 * 尽力而为地从终端快照中提取会话 id。
 *
 * @param snapshot 已去 ANSI 的完整终端缓冲（不限于底部，因为会话 id 通常在
 *                 会话启动时打印一次，随后会滚出可视区）。
 */
export function detectSessionId(snapshot: string): string | null {
  for (const pattern of SESSION_ID_PATTERNS) {
    const match = snapshot.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * 启动时校验全部 manifest 的 region 名（附录 D #21）。
 *
 * 必须在这里做而不是在 `manifests/index.ts`：部分 manifest 使用智能体私有的
 * region（如 codex 的 after_last_prompt_marker），解析器声明在各自 descriptor 里，
 * 只有本模块能同时拿到 manifest 与对应 descriptor。
 *
 * 原先未知 region 静默返回空串 —— 一个拼写错误就能让某条规则彻底失效且毫无提示。
 * 现在改为启动即抛错。运行期不再重复校验，避免每帧付代价。
 */
export function validateManifestRegionsAtStartup(): void {
  for (const [agentId, manifest] of Object.entries(MANIFESTS)) {
    const regions = agentById(agentId)?.detection?.regions;
    validateManifestRegions(manifest, regions);
  }
}
