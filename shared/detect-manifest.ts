/**
 * agent 检测 manifest 类型与内置清单。
 *
 * 参考 herdr `src/detect/manifests/*.toml` 的声明式检测思想：
 * 用正则匹配终端快照来判定 agent 状态，而不是解析 agent 的内部协议。
 */

import type { AgentDetectManifest } from './state';

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
): 'idle' | 'working' | 'blocked' | 'done' | 'unknown' {
  const lower = snapshot.toLowerCase();

  // blocked：需要人工输入/确认的强信号，比泛化的 "blocked" 更具体
  if (
    /\b(?:blocked|waiting for (?:input|you|confirmation|approval)|needs (?:your )?(?:attention|input|confirmation)|press (?:enter|any key)|approve\b|permission (?:requested|required)|\[y\/n\]|\(y\/n\)|allow\?|deny\?)\b/.test(
      lower,
    )
  ) {
    return 'blocked';
  }

  if (/\b(?:working|thinking|generating|in progress|running)\b/.test(lower)) {
    return 'working';
  }

  if (/\b(?:done|finished|completed|succeeded)\b/.test(lower)) {
    return 'done';
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
