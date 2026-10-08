/**
 * per-agent manifest 检测引擎 —— 对应 herdr `src/detect/manifest.rs`。
 *
 * herdr 把每个智能体的屏幕/OSC 检测规则放在独立 manifest（TOML）里，由统一的
 * 引擎求值：对每条规则取对应 region 的文本，用 gate（contains/regex/line_regex/
 * all/any/not）匹配，取优先级最高的命中规则作为状态；无命中时已知 agent 回落 idle。
 *
 * desktop 用 TS 文件等价实现（每 agent 一个 `manifests/<agent>.ts`）。
 */

import type { DetectedState } from '../state';

/** 匹配门（对应 herdr ManifestGate）。 */
export interface ManifestGate {
  /** 全部包含（大小写不敏感）。 */
  contains?: string[];
  /** 全部匹配（JS 正则，支持 (?i)(?m) 等 Rust 内联标志前缀）。 */
  regex?: string[];
  /** 每一行至少命中一次（JS 正则）。 */
  lineRegex?: string[];
  /** 全部嵌套门必须命中。 */
  all?: ManifestGate[];
  /** 至少一个嵌套门命中（非空时）。 */
  any?: ManifestGate[];
  /** 所有嵌套门都不能命中。 */
  not?: ManifestGate[];
}

/** 单条规则（对应 herdr ManifestRule）。 */
export interface ManifestRule {
  id: string;
  state: DetectedState;
  /** 命中优先级，越高越优先。 */
  priority: number;
  /** region 名，见 region()。 */
  region: string;
  visibleIdle?: boolean;
  visibleBlocker?: boolean;
  visibleWorking?: boolean;
  skipStateUpdate?: boolean;
  contains?: string[];
  regex?: string[];
  lineRegex?: string[];
  all?: ManifestGate[];
  any?: ManifestGate[];
  not?: ManifestGate[];
}

export interface AgentManifest {
  id: string;
  rules: ManifestRule[];
}

export interface ManifestDetection {
  state: DetectedState;
  visibleIdle: boolean;
  visibleBlocker: boolean;
  visibleWorking: boolean;
  skipStateUpdate: boolean;
}

export interface DetectionInput {
  screen: string;
  oscTitle: string;
  oscProgress: string;
}

/** 把 Rust regex 内联标志 (?i)(?m)(?s) 转换为 JS flags，并翻译 \p{} 属性。 */
function compileRegex(pattern: string): RegExp {
  let flags = '';
  let source = pattern;
  const inline = /^\(\?([imsu]+)\)/.exec(source);
  if (inline) {
    flags = inline[1];
    source = source.slice(inline[0].length);
  }
  // Rust 的 \p{Alphabetic} 等属性名转 JS 属性转义（需 u 标志）
  if (/\\p\{/.test(source)) {
    if (!flags.includes('u')) flags += 'u';
    source = source.replace(/\\p\{Alphabetic\}/g, '\\p{L}');
  }
  return new RegExp(source, flags);
}

/** 取 rule 顶层的 matcher 组合成 gate（对应 herdr manifest_gate_from_rule）。 */
function ruleGate(rule: ManifestRule): ManifestGate {
  return {
    all: rule.all,
    any: rule.any,
    not: rule.not,
    contains: rule.contains,
    regex: rule.regex,
    lineRegex: rule.lineRegex,
  };
}

function gateMatches(gate: ManifestGate, text: string, lowerText: string): boolean {
  if (gate.contains && !gate.contains.every((needle) => lowerText.includes(needle.toLowerCase()))) {
    return false;
  }
  if (gate.regex && !gate.regex.every((pattern) => compileRegex(pattern).test(text))) {
    return false;
  }
  if (
    gate.lineRegex &&
    !gate.lineRegex.every((pattern) => {
      const re = compileRegex(pattern);
      return text.split('\n').some((line) => re.test(line));
    })
  ) {
    return false;
  }
  if (gate.all && !gate.all.every((nested) => gateMatches(nested, text, lowerText))) {
    return false;
  }
  if (
    gate.any &&
    gate.any.length > 0 &&
    !gate.any.some((nested) => gateMatches(nested, text, lowerText))
  ) {
    return false;
  }
  if (gate.not && gate.not.some((nested) => gateMatches(nested, text, lowerText))) {
    return false;
  }
  return true;
}

/** 是否是水平分隔线（`────` 等，对应 herdr is_horizontal_rule）。 */
function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  let ruleChars = 0;
  while (ruleChars < trimmed.length && trimmed[ruleChars] === '\u2500') {
    ruleChars += 1;
  }
  if (ruleChars === 0) return false;
  const suffix = trimmed.slice(ruleChars).trimStart();
  return suffix.length === 0 || ruleChars >= 3;
}

/** 从第 N 个（含）行开始到结尾（对应 herdr bottom_non_empty_lines）。 */
function bottomNonEmptyLines(content: string, count: number): string {
  const lines = content.split('\n');
  let startIndex = -1;
  let seen = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() !== '') {
      seen += 1;
      // 记录当前最靠上的非空行下标；不足 count 时返回从第一个非空行开始
      startIndex = i;
      if (seen >= count) break;
    }
  }
  return startIndex < 0 ? '' : lines.slice(startIndex).join('\n');
}

/** 最后一条水平分隔线之后的内容（对应 herdr after_last_horizontal_rule）。 */
function afterLastHorizontalRule(content: string): string {
  const lines = content.split('\n');
  let lastRuleEnd = 0;
  let offset = 0;
  for (const line of lines) {
    const next = offset + line.length + 1;
    if (isHorizontalRule(line)) {
      lastRuleEnd = Math.min(next, content.length);
    }
    offset = next;
  }
  return content.slice(lastRuleEnd);
}

/** prompt 框上边框下标（倒数第二条水平线，对应 herdr prompt_box_top_border_index）。 */
function promptBoxTopBorderIndex(lines: string[]): number {
  let borderCount = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isHorizontalRule(lines[i])) {
      borderCount += 1;
      if (borderCount === 2) return i;
    }
  }
  return -1;
}

/** prompt 框正文（两条水平线之间，对应 herdr prompt_box_body）。 */
function promptBoxBody(content: string): string {
  const lines = content.split('\n');
  const top = promptBoxTopBorderIndex(lines);
  if (top < 0) return '';
  const end = lines.findIndex((line, i) => i > top && isHorizontalRule(line));
  const endIndex = end < 0 ? lines.length : end;
  return lines.slice(top + 1, endIndex).join('\n');
}

/** prompt 框之上的最后一条非空行（对应 herdr last_non_empty_above_prompt_box）。 */
function lastNonEmptyAbovePromptBox(content: string): string {
  const lines = content.split('\n');
  const top = promptBoxTopBorderIndex(lines);
  const above = top < 0 ? lines : lines.slice(0, top);
  for (let i = above.length - 1; i >= 0; i -= 1) {
    if (above[i].trim() !== '') return above[i];
  }
  return '';
}

/** 前 N 个非空行（从顶部数，对应 herdr top_non_empty_lines）。 */
function topNonEmptyLines(content: string, count: number): string {
  const lines = content.split('\n');
  let endIndex = -1;
  let seen = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '') {
      seen += 1;
      endIndex = i;
      if (seen >= count) break;
    }
  }
  return endIndex < 0 ? '' : lines.slice(0, endIndex + 1).join('\n');
}

/** codex 提示行：`›` 或 `› ...`（对应 herdr codex_prompt_line）。 */
function codexPromptLine(line: string): boolean {
  return line === '›' || line.startsWith('› ');
}

/** codex 块标记行：`•`/`■`/`✗`/`✓` 开头（对应 herdr codex_block_marker_line）。 */
function codexBlockMarkerLine(line: string): boolean {
  return line.startsWith('•') || line.startsWith('■') || line.startsWith('✗') || line.startsWith('✓');
}

/** 最后一条 codex 提示行之后的内容（对应 herdr after_last_prompt_marker）。 */
function afterLastPromptMarker(content: string): string {
  const lines = content.split('\n');
  let index = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (codexPromptLine(lines[i])) {
      index = i;
      break;
    }
  }
  return index < 0 ? content : lines.slice(index + 1).join('\n');
}

/** 当前 codex 提示行下标（最后一条，且其后无块标记，对应 herdr current_codex_prompt_index）。 */
function currentCodexPromptIndex(lines: string[]): number {
  let index = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (codexPromptLine(lines[i])) {
      index = i;
      break;
    }
  }
  if (index < 0) return -1;
  for (let i = index + 1; i < lines.length; i += 1) {
    if (codexBlockMarkerLine(lines[i])) return -1;
  }
  return index;
}

/** 当前 codex 提示行之前的内容（对应 herdr before_current_prompt_marker）。 */
function beforeCurrentPromptMarker(content: string): string {
  const lines = content.split('\n');
  const index = currentCodexPromptIndex(lines);
  return index < 0 ? content : lines.slice(0, index).join('\n');
}

/** 无当前提示标记时返回全文，否则空串（对应 herdr whole_recent_without_current_prompt_marker）。 */
function wholeRecentWithoutCurrentPromptMarker(content: string): string {
  const lines = content.split('\n');
  return currentCodexPromptIndex(lines) < 0 ? content : '';
}

/** 取 region 对应的文本（对应 herdr region()）。 */
function region(input: DetectionInput, spec: string): string {
  const trimmed = spec.trim();
  if (trimmed === 'osc_title') return input.oscTitle;
  if (trimmed === 'osc_progress') return input.oscProgress;

  const content = input.screen;
  if (trimmed === 'whole_recent') return content;
  if (trimmed === 'after_last_horizontal_rule') return afterLastHorizontalRule(content);
  if (trimmed === 'prompt_box_body') return promptBoxBody(content);
  if (trimmed === 'last_non_empty_above_prompt_box') {
    return lastNonEmptyAbovePromptBox(content);
  }
  if (trimmed === 'after_last_prompt_marker') return afterLastPromptMarker(content);
  if (trimmed === 'before_current_prompt_marker') return beforeCurrentPromptMarker(content);
  if (trimmed === 'whole_recent_without_current_prompt_marker') {
    return wholeRecentWithoutCurrentPromptMarker(content);
  }
  const bottomCount = /^bottom_non_empty_lines\((\d+)\)$/.exec(trimmed);
  if (bottomCount) {
    return bottomNonEmptyLines(content, Number(bottomCount[1]));
  }
  const topCount = /^top_non_empty_lines\((\d+)\)$/.exec(trimmed);
  if (topCount) {
    return topNonEmptyLines(content, Number(topCount[1]));
  }
  return '';
}

/** 求值一个 manifest（对应 herdr evaluate_loaded_manifest）。 */
export function evaluateManifest(
  manifest: AgentManifest,
  input: DetectionInput,
): ManifestDetection {
  let matched: ManifestRule | null = null;

  for (const rule of manifest.rules) {
    const regionText = region(input, rule.region);
    const ok = gateMatches(ruleGate(rule), regionText, regionText.toLowerCase());
    if (!ok) continue;
    if (matched === null || rule.priority > matched.priority) {
      matched = rule;
    }
  }

  if (matched === null) {
    return {
      state: 'idle',
      visibleIdle: false,
      visibleBlocker: false,
      visibleWorking: false,
      skipStateUpdate: false,
    };
  }

  const state = matched.state;
  return {
    state,
    visibleIdle: matched.visibleIdle === true && state === 'idle',
    visibleBlocker: matched.visibleBlocker === true && state === 'blocked',
    visibleWorking: matched.visibleWorking === true && state === 'working',
    skipStateUpdate: matched.skipStateUpdate === true,
  };
}
