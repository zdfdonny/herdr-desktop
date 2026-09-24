/**
 * Agent 状态检测引擎 —— 对应 herdr `src/detect/`。
 *
 * 从终端快照（bottom-buffer）推断 agent 名与状态，与渲染/布局解耦。
 * 使用 shared/detect-manifest 的声明式规则。
 */

import { detectStatus, detectAgentName } from '../../shared/detect-manifest';
import type { AgentState } from '../../shared/state';

export interface DetectionResult {
  name: string | null;
  title: string | null;
  status: AgentState['status'];
}

/** shell 启动横幅与提示符，不作为 agent 标题展示。 */
const NOISE_PATTERNS: RegExp[] = [
  /^PS\s+[A-Za-z]:\\/i, // PowerShell 提示符
  /^[A-Za-z]:\\[^>]*>\s*$/, // cmd 提示符
  /^[\w.-]+@[\w.-]+:.*[$#]\s*$/, // bash/zsh 提示符
  /^Windows PowerShell$/i,
  /^版权所有/,
  /^\(c\)\s*Microsoft/i,
  /^Install the latest PowerShell/i,
  /^安装最新的\s*PowerShell/i,
  /^\s*$/,
];

/**
 * 去除 ANSI 转义序列。
 *
 * 终端 buffer 里混有 CSI/OSC 控制码（如清屏 `\x1b[2J`、光标隐藏 `\x1b[?25l`），
 * 会干扰基于行首的正则匹配，因此先剥离再做检测。
 */
function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC ... BEL/ST
    .replace(/\x1b[@-Z\\-_]/g, '') // 两字节 ESC 序列
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI 序列
    .replace(/\x1b[()][A-Za-z0-9]/g, ''); // 字符集选择
}

/** 判断一行是否为 shell 噪声。 */
function isNoise(line: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(line.trim()));
}

/**
 * 从一段终端快照文本推断 agent 名、标题与状态。
 *
 * 只对「底部缓冲」做状态/名称检测，对齐 herdr 的 bottom-buffer 思想：
 * PTY 缓冲累积的是全量历史（最高 200k 字符），若对整个缓冲做关键词匹配，
 * 早先出现过的 "done"/"working" 会一直残留，状态无法回落到 idle，
 * 也会触发错误的 blocked/done 通知。
 */
export function detectFromSnapshot(snapshot: string): DetectionResult {
  const clean = stripAnsi(snapshot).trim();
  const bottom = bottomBuffer(clean);
  const name = detectAgentName(bottom);
  const status = detectStatus(name, bottom);
  const title = extractTitle(clean);
  return { name, title, status };
}

/** 只保留底部最近的若干行，用于检测（避免历史关键词残留）。 */
function bottomBuffer(text: string): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(-BOTTOM_LINES).join('\n');
}

/** 底部检测窗口：大约覆盖一屏 TUI（按行近似）。 */
const BOTTOM_LINES = 40;

/**
 * 标题提取：取最后一段有意义的行。
 *
 * 跳过 shell 横幅与提示符，避免把 "PS D:\...>" 或横幅片段当作 agent 标题。
 * 若全部是噪声则返回 null，由 UI 回退显示 paneId。
 */
function extractTitle(snapshot: string): string | null {
  const lines = snapshot
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isNoise(l));

  if (lines.length === 0) return null;

  const last = lines[lines.length - 1];
  // 超长行只保留开头，便于阅读
  return last.length > 80 ? `${last.slice(0, 77)}...` : last;
}
