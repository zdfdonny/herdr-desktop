/**
 * Agent 状态检测引擎 —— 对应 herdr `src/detect/`。
 *
 * 从终端快照（bottom-buffer）推断 agent 名与状态，与渲染/布局解耦。
 * 使用 shared/detect-manifest 的声明式规则。
 */

import { detectStatus, detectAgentName, detectSessionId, parseAgentLabel } from '../../shared/detect-manifest';
import { ScreenBuffer } from '../../shared/screen-buffer';
import type { DetectedState } from '../../shared/state';

export interface DetectionResult {
  /** 纯检测到的 agent 名（canonical，未命中为 null；对应 herdr 的 detected_agent）。 */
  detectedName: string | null;
  /** 显示名：纯检测名回退到启动命令首 token（供 UI 展示，非状态权威）。 */
  name: string | null;
  title: string | null;
  status: DetectedState;
  /** 本帧屏幕可见「需要人工输入」信号（对应 herdr AgentDetection.visible_blocker）。 */
  visibleBlocker: boolean;
  /** 本帧屏幕可见 idle 信号（诊断用，对应 herdr visible_idle）。 */
  visibleIdle: boolean;
  /** 本帧屏幕可见 working 信号（诊断用，对应 herdr visible_working）。 */
  visibleWorking: boolean;
  /** 当前是否为只看历史/不看实时提示的观众视图（对应 herdr skip_state_update，当前恒 false）。 */
  skipStateUpdate: boolean;
  /** 尽力而为的会话 id（见 detect-manifest 的 detectSessionId）。 */
  sessionId: string | null;
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

/**
 * 折叠回车覆盖（\r）与 CRLF 换行。
 *
 * 终端用 \r 原地刷新进度/spinner：claude 的 "✻ Brewing… (3s · esc to interrupt)"
 * 会在同一行被覆盖为 "✻ Brewed for 3s · done 13:40"，raw buffer 里两者都会留下。
 * 检测时只取每个逻辑行的最后一段（最后一次覆盖的结果），否则已结束的
 * "Brewing…" 会被误判为仍在工作。
 */
function normalizeCarriageReturns(text: string): string {
  const noCrlf = text.replace(/\r\n/g, '\n');
  return noCrlf
    .split('\n')
    .map((line) => {
      const idx = line.lastIndexOf('\r');
      return idx >= 0 ? line.slice(idx + 1) : line;
    })
    .join('\n');
}

/** 对应 herdr `sanitize_agent_osc_string`：去控制字符 + 截断。 */
function sanitizeOscString(payload: string): string {
  return payload
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 256);
}

/**
 * 提取最新的 OSC 0/2 标题（对应 herdr `agent_osc_title`）。
 *
 * claude 等通过 OSC 0/2 标题上报工作状态：working 时标题以 braille/半圆 spinner
 * 开头，idle 时以 "✳ " 开头。必须在 stripAnsi 丢弃 OSC 之前提取；取最后一次。
 */
function extractLatestOscTitle(raw: string): string {
  const re = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let latest = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const title = sanitizeOscString(m[1]);
    latest = title.length > 0 ? title : '';
  }
  return latest;
}

/**
 * 提取最新的 OSC 9 进度负载（对应 herdr `agent_osc_progress`）。
 *
 * 负载是 OSC body 去掉 "9;" 前缀后的部分，如 "4;0;"（idle）或 "4;1;"（working）。
 */
function extractLatestOscProgress(raw: string): string {
  const re = /\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let latest = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    latest = sanitizeOscString(m[1]);
  }
  return latest;
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
export function detectFromSnapshot(
  snapshot: string,
  /** 终端检测不到 agent 名时的回退（通常取 pane 的启动命令首 token）。 */
  fallbackName?: string | null,
): DetectionResult {
  // OSC 标题/进度（对应 herdr agent_osc_title / agent_osc_progress）：
  // claude 等通过 OSC 0/2 标题显示 spinner、通过 OSC 9;4 上报进度，
  // 必须在屏幕缓冲丢弃 OSC 之前提取。
  const oscTitle = extractLatestOscTitle(snapshot);
  const oscProgress = extractLatestOscProgress(snapshot);

  // 还原当前可见屏幕（对应 herdr ghostty 的 detection_text）：按序重放字节流，
  // 维护光标/擦除/清屏，避免 claude/antigravity 等 TUI 用光标原地重绘时旧
  // spinner/footer 文本残留导致状态卡在 working。
  const screen = new ScreenBuffer();
  screen.feed(snapshot);
  const currentScreen = screen.text();
  const bottom = bottomBuffer(currentScreen);

  // 纯检测名（不含命令兜底）：显示名与状态判定分开，避免把 fallback 命令误当 agent。
  const detectedName = detectAgentName(bottom);
  // 命令派生的 agent 名（进程检测等价物）：用于按 agent 路由到专属检测规则。
  // antigravity 等 TUI 底部不打印品牌名，靠启动命令识别；纯 shell 命令 parse 为 null。
  const commandAgent = fallbackName ? parseAgentLabel(fallbackName) : null;
  const detectionAgent = commandAgent ?? detectedName;
  const status = detectStatus(detectionAgent, bottom, oscTitle, oscProgress);
  const name = detectedName ?? fallbackName ?? null;
  const title = extractTitle(currentScreen);
  // 会话 id 用全量缓冲兜底：它通常在会话启动时打印一次，随后滚出当前屏幕。
  const sessionId = detectSessionId(normalizeCarriageReturns(stripAnsi(snapshot)));
  /*
   * 可见信号：由状态近似推导（manifest 引擎可按命中规则返回更细的 visible_*，
   * 这里简化为 status 映射；blocked→visibleBlocker、working→visibleWorking、
   * idle→visibleIdle）。
   */
  const visibleBlocker = status === 'blocked';
  const visibleIdle = status === 'idle';
  const visibleWorking = status === 'working';
  const skipStateUpdate = false;
  return {
    name,
    detectedName,
    title,
    status,
    visibleBlocker,
    visibleIdle,
    visibleWorking,
    skipStateUpdate,
    sessionId,
  };
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
