/**
 * 智能体描述符注册表 —— **唯一需要手写的注册点**。
 *
 * 新增一个智能体的步骤：
 * 1. 新建 `descriptors/<agent>.ts` 导出一个 `AgentDescriptor`；
 * 2. 在下面的 `DESCRIPTORS` 数组里按 `AGENT_IDS` 的位置登记一行。
 *
 * 顺序必须与 `shared/agents/agent-id.ts` 的 `AGENT_IDS` 一致 —— 检测层的
 * 「第一条命中即返回」把声明顺序当作识别优先级。
 */

import { amp, cline, gemini, kiro, maki, muse } from './detection-only';
import { antigravity } from './antigravity';
import { claude } from './claude';
import { codex } from './codex';
import { copilot } from './copilot';
import { cursor } from './cursor';
import { devin } from './devin';
import { droid } from './droid';
import { dsh } from './dsh';
import { grok } from './grok';
import { hermes } from './hermes';
import { kilo } from './kilo';
import { kimi } from './kimi';
import { letta } from './letta';
import { mastracode } from './mastracode';
import { omp } from './omp';
import { opencode } from './opencode';
import { pi } from './pi';
import { qodercli } from './qodercli';
import { qwen } from './qwen';
import type { AgentDescriptor } from '../descriptor';

/** 全部智能体，顺序 = 识别优先级（与 AGENT_IDS 一致）。 */
export const DESCRIPTORS: readonly AgentDescriptor[] = [
  pi,
  claude,
  codex,
  gemini,
  cursor,
  devin,
  antigravity,
  cline,
  omp,
  mastracode,
  opencode,
  copilot,
  kimi,
  kiro,
  droid,
  amp,
  grok,
  hermes,
  kilo,
  qodercli,
  qwen,
  letta,
  maki,
  muse,
  dsh,
];

export {
  amp,
  antigravity,
  claude,
  cline,
  codex,
  copilot,
  cursor,
  devin,
  droid,
  dsh,
  gemini,
  grok,
  hermes,
  kilo,
  kimi,
  kiro,
  letta,
  maki,
  mastracode,
  muse,
  omp,
  opencode,
  pi,
  qodercli,
  qwen,
};
