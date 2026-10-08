/**
 * agent 检测 manifest 类型与内置清单。
 *
 * 参考 herdr `src/detect/manifests/*.toml` 的声明式检测思想：
 * 用正则匹配终端快照来判定 agent 状态，而不是解析 agent 的内部协议。
 */

import type { AgentDetectManifest, DetectedState } from './state';
import { evaluateManifest } from './detect/engine';
import { MANIFESTS } from './detect/manifests';

// 供测试直接校验 manifest 注册表与求值引擎
export { evaluateManifest, MANIFESTS };

/**
 * 各 agent 的识别关键词（命令名/品牌）。
 *
 * 用 `\b` 词边界避免子串误判（例如 `pi` 不能命中 "pip"/"api"）。
 * `detectAgentName` 只取 pattern 做识别，`status` 字段为其类型占位。
 */
const AGENT_IDENTITY: Array<[agent: string, pattern: string]> = [
  ['pi', '\\bpi\\b'],
  ['claude', '\\bclaude(?:-code)?\\b'],
  ['codex', '\\bcodex\\b'],
  ['gemini', '\\bgemini\\b'],
  ['cursor', '\\bcursor(?:-agent)?\\b'],
  ['devin', '\\bdevin\\b'],
  ['antigravity', '\\b(?:agy|antigravity)\\b'],
  ['cline', '\\bcline\\b'],
  ['omp', '\\bomp\\b'],
  ['mastracode', '\\b(?:mastracode|mastra)\\b'],
  ['opencode', '\\bopencode\\b'],
  ['copilot', '\\b(?:copilot|github-copilot|ghcs)\\b'],
  ['kimi', '\\bkimi\\b'],
  ['kiro', '\\bkiro(?:-cli)?\\b'],
  ['droid', '\\bdroid\\b'],
  ['amp', '\\bamp\\b'],
  ['grok', '\\bgrok\\b'],
  ['hermes', '\\bhermes\\b'],
  ['kilo', '\\bkilo\\b'],
  ['qodercli', '\\b(?:qodercli|qoder)\\b'],
  ['qwen', '\\bqwen\\b'],
  ['letta', '\\bletta\\b'],
  ['maki', '\\bmaki\\b'],
  ['muse', '\\bmuse\\b'],
];

/** canonical agent 名集合（与 AGENT_IDENTITY 的 agent 列一致）。 */
const AGENT_LABELS = new Set(AGENT_IDENTITY.map(([agent]) => agent));

/**
 * 别名 → canonical 名（对齐 herdr `lookup_agent`）。
 *
 * 唯一与 herdr 的差异：desktop 的 canonical 名是 `antigravity`（herdr 用 `agy`），
 * 因此 `agy` / `antigravity-cli` 归一到 `antigravity`。
 */
const AGENT_ALIASES: Record<string, string> = {
  'claude-code': 'claude',
  'cursor-agent': 'cursor',
  'devin-cli': 'devin',
  'devin cli': 'devin',
  agy: 'antigravity',
  'antigravity-cli': 'antigravity',
  '.cline': 'cline',
  'mastra-code': 'mastracode',
  'mastra code': 'mastracode',
  opencode2: 'opencode',
  'open-code': 'opencode',
  'github-copilot': 'copilot',
  ghcs: 'copilot',
  'kimi-code': 'kimi',
  'kimi code': 'kimi',
  'kiro-cli': 'kiro',
  'amp-local': 'amp',
  'grok-build': 'grok',
  'hermes-agent': 'hermes',
  'kilo-code': 'kilo',
  'kilo code': 'kilo',
  qoderclicn: 'qodercli',
  qoder: 'qodercli',
  qodercn: 'qodercli',
  'qwen-code': 'qwen',
  'qwen code': 'qwen',
  'letta-code': 'letta',
  'letta code': 'letta',
  'muse-code': 'muse',
  'muse-cli': 'muse',
};

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
 * 把上报/检测到的 agent 标签归一化为 canonical 名（对应 herdr `parse_agent_label`）。
 *
 * 未知标签返回 null。desktop 的检测层直接产出 canonical 字符串，
 * 因此这里不像 herdr 那样返回枚举，而是返回 canonical 字符串本身。
 */
export function parseAgentLabel(label: string): string | null {
  const name = pathBasename(normalizedAgentLookupName(label));
  if (AGENT_LABELS.has(name)) return name;
  return AGENT_ALIASES[name] ?? null;
}

/**
 * 完整生命周期 hook 权威白名单（对应 herdr `full_lifecycle_hook_authority`）。
 *
 * 这些集成的 hook 活着时对状态拥有权威，屏幕检测只作回退。
 */
export function fullLifecycleHookAuthority(source: string, agentLabel: string): boolean {
  return (
    (source === 'herdr:pi' && agentLabel === 'pi') ||
    (source === 'herdr:omp' && agentLabel === 'omp') ||
    (source === 'herdr:mastracode' && agentLabel === 'mastracode') ||
    (source === 'herdr:opencode' && agentLabel === 'opencode') ||
    (source === 'herdr:kilo' && agentLabel === 'kilo') ||
    (source === 'herdr:kimi' && agentLabel === 'kimi')
  );
}

/**
 * 仅上报会话身份的集成（对应 herdr `session_identity_only_integration`）。
 *
 * 这些来源不持有状态权威，只提供会话引用。
 */
export function sessionIdentityOnlyIntegration(source: string, agentLabel: string): boolean {
  return (
    (source === 'herdr:hermes' && agentLabel === 'hermes') ||
    (source === 'herdr:qwen' && agentLabel === 'qwen') ||
    (source === 'herdr:letta' && agentLabel === 'letta') ||
    (source === 'herdr:antigravity' && agentLabel === 'antigravity')
  );
}

export const BUILTIN_MANIFESTS: AgentDetectManifest[] = AGENT_IDENTITY.map(
  ([agent, pattern]) => ({
    agent,
    rules: [{ pattern, status: 'idle' }],
  }),
);

/**
 * 从一段终端快照文本 + 已识别 agent 名推断状态。
 *
 * 简化实现：优先匹配 blocked → working → done 的关键词，否则回落 idle/unknown。
 * 输入应来自底部缓冲（见 agent-detector 的 bottomBuffer），
 * 并尽量用词边界与更具体的「需要输入」信号降低误报。
 */
export function detectStatus(
  agentName: string | null,
  snapshot: string,
  oscTitle = '',
  oscProgress = '',
): DetectedState {
  const lower = snapshot.toLowerCase();

  // 特定 agent 的专属 manifest（每 agent 一个文件，见 shared/detect/manifests/）。
  // 避免通用关键词误命中常驻界面（如 antigravity idle footer / claude 响应正文）。
  if (agentName && MANIFESTS[agentName]) {
    return evaluateManifest(MANIFESTS[agentName], {
      screen: snapshot,
      oscTitle,
      oscProgress,
    }).state;
  }

  // blocked：需要人工输入/确认的信号（含各 agent 的权限确认文案）
  if (
    /\b(?:blocked|waiting for (?:input|you|confirmation|approval)|needs (?:your )?(?:attention|input|confirmation)|press (?:enter|any key)|approve\b|permission (?:requested|required)|\[y\/n\]|\(y\/n\)|allow\?|deny\?)\b/.test(
      lower,
    ) ||
    /\b(?:permission required|action required|enter to confirm|press enter to confirm|allow command\?|yes \(y\))\b/.test(
      lower,
    )
  ) {
    return 'blocked';
  }

  /*
   * working：各 agent 的工作中信号。不只有英文关键词，还覆盖：
   * - opencode 等：esc/ctrl+c/press esc to interrupt
   * - codex 等：`(12s • … to interrupt)` 计时后缀
   * - opencode 的进度条 ■■■■ / ⬝⬝⬝⬝
   */
  if (
    /\b(?:working|thinking|generating|in progress|running)\b/.test(lower) ||
    /(?:esc (?:again )?to interrupt|ctrl\+c to interrupt|press esc to interrupt|to interrupt\))/.test(
      lower,
    ) ||
    /(?:■|⬝){4,}/.test(snapshot)
  ) {
    return 'working';
  }

  return agentName ? 'idle' : 'unknown';
}

/** 从终端标题/快照中粗略识别 agent 名。 */
export function detectAgentName(snapshot: string): string | null {
  const lower = snapshot.toLowerCase();
  for (const manifest of BUILTIN_MANIFESTS) {
    for (const rule of manifest.rules) {
      if (rule.pattern && new RegExp(rule.pattern, 'i').test(lower)) {
        return manifest.agent;
      }
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
