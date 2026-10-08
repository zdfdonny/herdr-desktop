/**
 * manifest 注册表 —— 每 agent 一个文件（对应 herdr `src/detect/manifests/`）。
 *
 * 新增 agent 检测时：新建 `manifests/<agent>.ts` 导出 `<agent>Manifest`，
 * 然后在这里登记到 MANIFESTS map 即可，引擎自动路由。
 *
 * 说明：herdr 的 `SCREEN_MANIFEST_AGENTS` 共 22 个；omp / mastracode 无屏幕
 * manifest（它们是 full-lifecycle hook 权威，状态由 hook 提供，屏幕走通用兜底）。
 */

import type { AgentManifest } from '../engine';
import { ampManifest } from './amp';
import { antigravityManifest } from './antigravity';
import { claudeManifest } from './claude';
import { clineManifest } from './cline';
import { codexManifest } from './codex';
import { copilotManifest } from './copilot';
import { cursorManifest } from './cursor';
import { devinManifest } from './devin';
import { droidManifest } from './droid';
import { geminiManifest } from './gemini';
import { grokManifest } from './grok';
import { hermesManifest } from './hermes';
import { kiloManifest } from './kilo';
import { kimiManifest } from './kimi';
import { kiroManifest } from './kiro';
import { lettaManifest } from './letta';
import { makiManifest } from './maki';
import { museManifest } from './muse';
import { opencodeManifest } from './opencode';
import { piManifest } from './pi';
import { qodercliManifest } from './qodercli';
import { qwenManifest } from './qwen';

/** canonical agent 名 → manifest。 */
export const MANIFESTS: Record<string, AgentManifest> = {
  amp: ampManifest,
  antigravity: antigravityManifest,
  claude: claudeManifest,
  cline: clineManifest,
  codex: codexManifest,
  copilot: copilotManifest,
  cursor: cursorManifest,
  devin: devinManifest,
  droid: droidManifest,
  gemini: geminiManifest,
  grok: grokManifest,
  hermes: hermesManifest,
  kilo: kiloManifest,
  kimi: kimiManifest,
  kiro: kiroManifest,
  letta: lettaManifest,
  maki: makiManifest,
  muse: museManifest,
  opencode: opencodeManifest,
  pi: piManifest,
  qodercli: qodercliManifest,
  qwen: qwenManifest,
};
