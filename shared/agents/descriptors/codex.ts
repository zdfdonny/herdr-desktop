/**
 * Codex。
 *
 * 三处专属语义（重构前是 `terminal-state.ts:358/572/905/1244/1295/1318` 六处内联 if）：
 * - **prompt 就绪探针**：托管启动阶段不靠 idle 判「交互就绪」，而要屏幕出现当前
 *   prompt 标记（`›`）；即便检测状态还是 `unknown`，只要 prompt 就绪也算就绪；
 * - **会话显式替换**：状态上报不允许更换已锚定的会话（其它智能体可以），
 *   换会话必须走显式的替换来源；
 * - **启动参数反推**：`codex resume <id>` 可以还原出会话引用。
 */

import type { DetectionInput } from '../../detect/engine';
import { codexManifest } from '../../detect/manifests/codex';
import type { AgentDescriptor } from '../descriptor';
import { envOrHome } from '../spec/host';
import { hookArtifactPath, hookScriptName } from '../spec/integration-paths';
import { statePolicy } from '../spec/policy';
import { spacedTail } from '../spec/resume-spec';

/*
 * codex 的屏幕结构概念 —— 全部是 codex 私有的。重构前它们焊在通用引擎
 * `shared/detect/engine.ts` 里（5 个函数 + 3 个 region 名），
 * 其它二十多个智能体永远用不到。现在归 codex 自己管。
 */

/** codex 提示行：`›` 或 `› ...`。 */
function isPromptLine(line: string): boolean {
  return line === '›' || line.startsWith('› ');
}

/** codex 块标记行：`•` / `■` / `✗` / `✓` 开头。 */
function isBlockMarkerLine(line: string): boolean {
  return (
    line.startsWith('•') ||
    line.startsWith('■') ||
    line.startsWith('✗') ||
    line.startsWith('✓')
  );
}

/** 当前 codex 提示行下标（最后一条，且其后无块标记）。 */
function currentPromptIndex(lines: string[]): number {
  let index = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isPromptLine(lines[i])) {
      index = i;
      break;
    }
  }
  if (index < 0) return -1;
  for (let i = index + 1; i < lines.length; i += 1) {
    if (isBlockMarkerLine(lines[i])) return -1;
  }
  return index;
}

/** 最后一条 codex 提示行之后的内容。 */
function afterLastPromptMarker(input: DetectionInput): string {
  const lines = input.screen.split('\n');
  let index = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isPromptLine(lines[i])) {
      index = i;
      break;
    }
  }
  return index < 0 ? input.screen : lines.slice(index + 1).join('\n');
}

/** 当前 codex 提示行之前的内容。 */
function beforeCurrentPromptMarker(input: DetectionInput): string {
  const lines = input.screen.split('\n');
  const index = currentPromptIndex(lines);
  return index < 0 ? input.screen : lines.slice(0, index).join('\n');
}

/** 无当前提示标记时返回全文，否则空串。 */
function wholeRecentWithoutCurrentPromptMarker(input: DetectionInput): string {
  const lines = input.screen.split('\n');
  return currentPromptIndex(lines) < 0 ? input.screen : '';
}

export const codex: AgentDescriptor = {
  id: 'codex',
  detectionPriority: 30,
  label: 'Codex',
  command: () => 'codex',

  detection: {
    identity: '\\bcodex\\b',
    manifest: codexManifest,
    regions: {
      after_last_prompt_marker: afterLastPromptMarker,
      before_current_prompt_marker: beforeCurrentPromptMarker,
      whole_recent_without_current_prompt_marker: wholeRecentWithoutCurrentPromptMarker,
    },
  },

  integration: {
    kind: 'json-hooks',
    version: 4,
    configDir: (host) => envOrHome(host, 'CODEX_HOME', ['.codex']),
    artifactPath: (host) =>
      hookArtifactPath(host, envOrHome(host, 'CODEX_HOME', ['.codex']), null, hookScriptName(host)),
  },

  resume: {
    replacementSources: ['startup', 'clear', 'resume', 'compact'],
    tail: spacedTail('resume'),
    /** 只为 `codex resume <id>` 这一种显式形态反推；`--last` 等不算。 */
    fromLaunchArgs: (args) => {
      if (args.length !== 2) return null;
      const [command, sessionId] = args;
      if (command !== 'resume' || sessionId.startsWith('-')) return null;
      return { kind: 'id', value: sessionId };
    },
  },

  policy: statePolicy({
    hookAuthority: 'state',
    sessionRebinding: { mode: 'explicit-replace', allowForegroundTakeover: true },
    readiness: { acceptsIdle: true, requiresPromptMarker: true },
  }),
};
