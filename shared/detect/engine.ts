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

/** 智能体私有的 region 解析器（由 DetectionSpec.regions 提供）。 */
export type RegionResolver = (input: DetectionInput) => string;

/**
 * 编译后的正则缓存（附录 D #22）。
 *
 * 为什么需要：`gateMatches` 会被每条 PTY chunk × 每条规则调用，
 * 而规则数在百条量级（19 个 manifest 合计）。不缓存时每个 chunk 要做上百次
 * `new RegExp` —— 正则编译是其中相对昂贵的部分，纯属重复劳动。
 *
 * 安全性：pattern 来自静态 manifest，总数有界（不会无界增长）；flags 只取自
 * `[imsu]`，不含 `g`/`y`，因此不存在 `lastIndex` 状态残留问题，可安全复用。
 */
const regexCache = new Map<string, RegExp>();

/** 把 Rust regex 内联标志 (?i)(?m)(?s) 转换为 JS flags，并翻译 \p{} 属性。 */
function compileRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;

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
  const compiled = new RegExp(source, flags);
  regexCache.set(pattern, compiled);
  return compiled;
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

/** gate 是否没有任何实际条件（全 undefined / 全空数组）。 */
function gateIsEmpty(gate: ManifestGate): boolean {
  const has = (list: unknown[] | undefined): boolean => Boolean(list && list.length > 0);
  return !(
    has(gate.contains) ||
    has(gate.regex) ||
    has(gate.lineRegex) ||
    has(gate.all) ||
    has(gate.any) ||
    has(gate.not)
  );
}

function gateMatches(gate: ManifestGate, text: string, lowerText: string): boolean {
  /*
   * 空 gate 一律不匹配（附录 D #23）。
   *
   * 原先所有条件都是 undefined 时会直接落到 return true —— 一条忘写条件的规则
   * 会命中任何屏幕，把状态永久钉死在该规则的 status 上，且没有任何报错。
   * 按「没有条件 = 不匹配」处理，配合 validateManifests 的加载期校验，
   * 写错会立刻被发现而不是静默生效。
   */
  if (gateIsEmpty(gate)) return false;

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

/**
 * 引擎内置的 region 名（不含各智能体的 `extraRegions`）。
 *
 * 与 `region()` 里的分支一一对应；校验时用它 + 各 agent 的 extraRegions 判定合法名。
 */
const BUILTIN_REGIONS = [
  'osc_title',
  'osc_progress',
  'whole_recent',
  'after_last_horizontal_rule',
  'prompt_box_body',
  'last_non_empty_above_prompt_box',
] as const;

/** 带参数的内置 region 形态（`bottom_non_empty_lines(3)` 之类）。 */
const PARAMETRIC_REGION = /^(?:bottom|top)_non_empty_lines\(\d+\)$/;

/** 某个 region 名是否被引擎或该 manifest 的 extraRegions 识别。 */
export function isKnownRegion(
  name: string,
  extraRegions?: Record<string, RegionResolver>,
): boolean {
  const trimmed = name.trim();
  if (extraRegions && trimmed in extraRegions) return true;
  if ((BUILTIN_REGIONS as readonly string[]).includes(trimmed)) return true;
  return PARAMETRIC_REGION.test(trimmed);
}

/**
 * 校验 manifest 里所有 region 名都能被解析（附录 D #21）。
 *
 * 原先未知 region 名静默返回空串，规则因此永久不命中且毫无提示 ——
 * 一个拼写错误就能让某条检测规则彻底失效。改为在**加载期**抛错：
 * region 名是静态数据，写错是开发期错误，应该在启动时立刻炸掉，
 * 而不是等到用户发现「这个智能体状态一直不对」。运行期不再抛错，
 * 避免每帧都付校验代价。
 */
export function validateManifestRegions(
  manifest: AgentManifest,
  extraRegions?: Record<string, RegionResolver>,
): void {
  const unknown: string[] = [];
  for (const rule of manifest.rules) {
    if (!isKnownRegion(rule.region, extraRegions)) {
      unknown.push(`rule "${rule.id}" → region "${rule.region}"`);
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `manifest "${manifest.id}" 引用了未知 region：\n  ${unknown.join('\n  ')}\n` +
        `已知内置 region：${BUILTIN_REGIONS.join(', ')}，` +
        `或形如 bottom_non_empty_lines(3) / top_non_empty_lines(2)；` +
        `智能体私有 region 需在该 agent 的 DetectionSpec.regions 里声明。`,
    );
  }
}

/**
 * 取 region 对应的文本（对应 herdr region()）。
 *
 * 只包含**所有智能体通用**的区域切片原语；某个智能体私有的屏幕结构概念
 * （如 codex 的 prompt 标记区域）由它自己的 descriptor 通过 `extraRegions` 提供，
 * 通用引擎不再认识具体智能体。
 */
function region(
  input: DetectionInput,
  spec: string,
  extraRegions: Record<string, RegionResolver> | undefined,
): string {
  const trimmed = spec.trim();
  const extra = extraRegions?.[trimmed];
  if (extra) return extra(input);

  if (trimmed === 'osc_title') return input.oscTitle;
  if (trimmed === 'osc_progress') return input.oscProgress;

  const content = input.screen;
  if (trimmed === 'whole_recent') return content;
  if (trimmed === 'after_last_horizontal_rule') return afterLastHorizontalRule(content);
  if (trimmed === 'prompt_box_body') return promptBoxBody(content);
  if (trimmed === 'last_non_empty_above_prompt_box') {
    return lastNonEmptyAbovePromptBox(content);
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

/**
 * 求值一个 manifest（对应 herdr evaluate_loaded_manifest）。
 *
 * @param extraRegions 智能体私有的 region 解析器（见 DetectionSpec.regions）
 */
export function evaluateManifest(
  manifest: AgentManifest,
  input: DetectionInput,
  extraRegions?: Record<string, RegionResolver>,
): ManifestDetection {
  let matched: ManifestRule | null = null;

  for (const rule of manifest.rules) {
    const regionText = region(input, rule.region, extraRegions);
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
