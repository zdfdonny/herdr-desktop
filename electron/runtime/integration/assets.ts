/**
 * 集成资产加载器 —— 对应 herdr `src/integration/assets/`。
 *
 * 每个智能体的脚本单独存放在 `assets/<agent>/` 文件夹里，通过 Vite 的 `?raw`
 * 导入（等价于 herdr 的 `include_str!`）在构建期内联进主进程产物。
 *
 * hook 脚本目前是通用的（agent 名经 `HERDR_DESKTOP_AGENT` 环境变量传入，所以各
 * 文件内容一致），但仍按智能体分文件夹存放，便于后续为单个 agent 定制脚本。
 * 上报通道统一走本地 HTTP 上报端点（`HERDR_DESKTOP_REPORT_URL`）。
 */

// hook 脚本（bash / PowerShell，带标记 + 状态上报）
import claudePs1 from './assets/claude/herdr-desktop-agent-state.ps1?raw';
import claudeSh from './assets/claude/herdr-desktop-agent-state.sh?raw';
import codexPs1 from './assets/codex/herdr-desktop-agent-state.ps1?raw';
import codexSh from './assets/codex/herdr-desktop-agent-state.sh?raw';
import kimiPs1 from './assets/kimi/herdr-desktop-agent-state.ps1?raw';
import kimiSh from './assets/kimi/herdr-desktop-agent-state.sh?raw';
import copilotPs1 from './assets/copilot/herdr-desktop-agent-state.ps1?raw';
import copilotSh from './assets/copilot/herdr-desktop-agent-state.sh?raw';
import devinPs1 from './assets/devin/herdr-desktop-agent-state.ps1?raw';
import devinSh from './assets/devin/herdr-desktop-agent-state.sh?raw';
import droidPs1 from './assets/droid/herdr-desktop-agent-state.ps1?raw';
import droidSh from './assets/droid/herdr-desktop-agent-state.sh?raw';
import qodercliPs1 from './assets/qodercli/herdr-desktop-agent-state.ps1?raw';
import qodercliSh from './assets/qodercli/herdr-desktop-agent-state.sh?raw';
import qwenPs1 from './assets/qwen/herdr-desktop-agent-session.ps1?raw';
import qwenSh from './assets/qwen/herdr-desktop-agent-session.sh?raw';
import lettaPs1 from './assets/letta/herdr-desktop-agent-session.ps1?raw';
import lettaSh from './assets/letta/herdr-desktop-agent-session.sh?raw';
import cursorPs1 from './assets/cursor/herdr-desktop-agent-state.ps1?raw';
import cursorSh from './assets/cursor/herdr-desktop-agent-state.sh?raw';
import mastracodePs1 from './assets/mastracode/herdr-desktop-agent-state.ps1?raw';
import mastracodeSh from './assets/mastracode/herdr-desktop-agent-state.sh?raw';
import antigravityPs1 from './assets/antigravity/herdr-desktop-agent-state.ps1?raw';
import antigravitySh from './assets/antigravity/herdr-desktop-agent-state.sh?raw';
import grokPs1 from './assets/grok/herdr-desktop-agent-state.ps1?raw';
import grokSh from './assets/grok/herdr-desktop-agent-state.sh?raw';

// 非 hook 集成资产（extension / plugin）
import piAsset from './assets/pi/herdr-desktop-agent-state.ts?raw';
import ompAsset from './assets/omp/herdr-desktop-omp-agent-state.ts?raw';
import opencodeAsset from './assets/opencode/herdr-desktop-agent-state.js?raw';
import kiloAsset from './assets/kilo/herdr-desktop-agent-state.js?raw';
import hermesPluginYaml from './assets/hermes/plugin.yaml?raw';
import hermesPluginInit from './assets/hermes/__init__.py?raw';
import dshStatusPlugin from './assets/dsh-web/herdr-desktop-agent-state.mjs?raw';

/** 使用 hook 脚本的智能体。 */
export type HookScriptAgent =
  | 'claude'
  | 'codex'
  | 'kimi'
  | 'copilot'
  | 'devin'
  | 'droid'
  | 'qodercli'
  | 'qwen'
  | 'letta'
  | 'cursor'
  | 'mastracode'
  | 'antigravity'
  | 'grok';

/** 每个智能体单独的 hook 脚本资产（按平台区分）。 */
export const HOOK_SCRIPTS: Record<HookScriptAgent, { ps1: string; sh: string }> = {
  claude: { ps1: claudePs1, sh: claudeSh },
  codex: { ps1: codexPs1, sh: codexSh },
  kimi: { ps1: kimiPs1, sh: kimiSh },
  copilot: { ps1: copilotPs1, sh: copilotSh },
  devin: { ps1: devinPs1, sh: devinSh },
  droid: { ps1: droidPs1, sh: droidSh },
  qodercli: { ps1: qodercliPs1, sh: qodercliSh },
  qwen: { ps1: qwenPs1, sh: qwenSh },
  letta: { ps1: lettaPs1, sh: lettaSh },
  cursor: { ps1: cursorPs1, sh: cursorSh },
  mastracode: { ps1: mastracodePs1, sh: mastracodeSh },
  antigravity: { ps1: antigravityPs1, sh: antigravitySh },
  grok: { ps1: grokPs1, sh: grokSh },
};

/** 取某个智能体在当前平台下的 hook 脚本内容。 */
export function hookScriptContent(agent: HookScriptAgent, windows: boolean): string {
  return windows ? HOOK_SCRIPTS[agent].ps1 : HOOK_SCRIPTS[agent].sh;
}

/** pi 扩展（`herdr-agent-state.ts`）。 */
export const PI_ASSET = piAsset;
/** omp 扩展（`herdr-omp-agent-state.ts`）。 */
export const OMP_ASSET = ompAsset;
/** opencode 插件（`herdr-agent-state.js`）。 */
export const OPENCODE_ASSET = opencodeAsset;
/** kilo 插件（`herdr-agent-state.js`）。 */
export const KILO_ASSET = kiloAsset;
/** hermes 插件 manifest。 */
export const HERMES_PLUGIN_YAML = hermesPluginYaml;
/** hermes 插件入口（`__init__.py`）。 */
export const HERMES_PLUGIN_INIT = hermesPluginInit;
/** DeepSeek Harness 状态上报插件（`herdr-desktop-agent-state.mjs`）。 */
export const DSH_STATUS_PLUGIN = dshStatusPlugin;

/**
 * DeepSeek Harness 状态上报插件的文件名（含 .mjs 后缀，确保按 ESM 加载，
 * 与 profile 的 package.json 是否声明 "type": "module" 无关）。
 */
export const DSH_STATUS_PLUGIN_NAME = 'herdr-desktop-agent-state.mjs';
