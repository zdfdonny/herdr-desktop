/**
 * manifest 注册表 —— 每 agent 一个文件（对应 herdr `src/detect/manifests/`）。
 *
 * 新增 agent 检测时：新建 `manifests/<agent>.ts` 导出 `<agent>Manifest`，
 * 然后在这里登记到 MANIFESTS map 即可，引擎自动路由。
 *
 * 说明：herdr 的 `SCREEN_MANIFEST_AGENTS` 共 22 个；omp / mastracode 无屏幕
 * manifest（它们是 full-lifecycle hook 权威，状态由 hook 提供，屏幕走通用兜底）。
 */

import { validateManifestRegions, type AgentManifest } from '../engine';
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

/*
 * 加载期校验由 `validateAllManifests()` 完成，**不在这里自动跑**。
 *
 * 原因：部分 manifest 使用智能体私有的 region（如 codex 的
 * `after_last_prompt_marker`），这些解析器声明在各自的 descriptor 里。
 * 本模块只掌握 manifest，拿不到 extraRegions，贸然校验会误报。
 *
 * 真正的完整校验在 `shared/detect/facade.ts`（那里能按 agent 取到 descriptor），
 * 由它遍历全部 manifest + 各自的 extraRegions 调 `validateManifestRegions`。
 */
export function validateAllManifests(
  extraRegionsFor?: (agentId: string) => Record<string, unknown> | undefined,
): void {
  for (const [agentId, manifest] of Object.entries(MANIFESTS)) {
    validateManifestRegions(
      manifest,
      extraRegionsFor?.(agentId) as Parameters<typeof validateManifestRegions>[1],
    );
  }
}
