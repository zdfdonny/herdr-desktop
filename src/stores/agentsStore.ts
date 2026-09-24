/**
 * agents store —— agent 命令清单与可用性。
 *
 * Agent 选择体验：只突出显示本机真实可用的 agent，
 * 未安装的给出明确提示而不是让 spawn 失败。
 */

import { create } from 'zustand';
import { getAgentAvailability } from '../ipc/client';
import { isMac, isWindows } from '../platform';

export interface AgentPreset {
  /** 稳定标识。 */
  id: string;
  /** 展示名（品牌名，通常不翻译）。 */
  label: string;
  /** 启动命令（web 预设仅用于可用性探测，实际启动走 spawnWebAgent）。 */
  command: string;
  /** 创建方式：普通终端进程（默认）或内嵌 Web GUI。 */
  kind?: 'pty' | 'web';
}

/**
 * 普通终端预设的启动命令（按平台）。
 *
 * 这是桌面端自有预设，不属于 herdr 的 agent 清单：
 * - Windows：PowerShell（不存在时主进程会回退到 ComSpec）
 * - macOS / Linux：由主进程 `resolveDefaultShell()` 解析登录 shell
 *
 * 这里用平台默认值占位，实际启动时主进程的 `defaultShellCommand()` 会兜底，
 * 因此即使该命令在本机解析不到，终端预设依然可用。
 */
const TERMINAL_COMMAND = isWindows ? 'powershell.exe' : isMac ? '/bin/zsh' : '/bin/bash';

/**
 * Cursor Agent 的启动命令。
 * Windows 上是 npm 生成的 `.cmd` 垫片；macOS / Linux 上是无扩展名的可执行文件。
 */
const CURSOR_COMMAND = isWindows ? 'cursor-agent.cmd' : 'cursor-agent';

/**
 * 内置 agent 预设。
 *
 * 对照 herdr `src/detect/mod.rs` 的 `Agent::ALL`（24 个智能体），
 * 启动命令取 `interactive_agent_executable` 的对应平台值。
 * `terminal`（普通终端）为桌面端自有预设，保留不动。
 */
export const AGENT_PRESETS: AgentPreset[] = [
  { id: 'pi', label: 'Pi', command: 'pi' },
  { id: 'claude', label: 'Claude Code', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini' },
  { id: 'cursor', label: 'Cursor Agent CLI', command: CURSOR_COMMAND },
  { id: 'devin', label: 'Devin CLI', command: 'devin' },
  { id: 'antigravity', label: 'Antigravity CLI', command: 'agy' },
  { id: 'cline', label: 'Cline', command: 'cline' },
  { id: 'omp', label: 'OMP', command: 'omp' },
  { id: 'mastracode', label: 'MastraCode', command: 'mastracode' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode' },
  { id: 'copilot', label: 'GitHub Copilot CLI', command: 'copilot' },
  { id: 'kimi', label: 'Kimi Code CLI', command: 'kimi' },
  { id: 'kiro', label: 'Kiro CLI', command: 'kiro-cli' },
  { id: 'droid', label: 'Droid', command: 'droid' },
  { id: 'amp', label: 'Amp', command: 'amp' },
  { id: 'grok', label: 'Grok CLI', command: 'grok' },
  { id: 'hermes', label: 'Hermes Agent', command: 'hermes' },
  { id: 'kilo', label: 'Kilo Code CLI', command: 'kilo' },
  { id: 'qodercli', label: 'Qoder CLI', command: 'qodercli' },
  { id: 'qwen', label: 'Qwen Code', command: 'qwen' },
  { id: 'letta', label: 'Letta Code', command: 'letta' },
  { id: 'maki', label: 'Maki', command: 'maki' },
  { id: 'muse', label: 'Muse', command: 'muse' },
  { id: 'terminal', label: 'Terminal', command: TERMINAL_COMMAND },
  /*
   * DeepSeek Harness（Web GUI）：不是终端 TUI，而是由主进程托管 `dsh web`
   * 后经 <webview> 内嵌。command 仅用于可用性探测（探测 `dsh` 是否在 PATH）。
   */
  { id: 'dsh-web', label: 'DeepSeek Harness', command: 'dsh', kind: 'web' },
];

interface AgentsStore {
  /** 命令 → 是否可用。 */
  availability: Record<string, boolean>;
  /** 是否已完成探测。 */
  probed: boolean;
  refresh: () => Promise<void>;
}

export const useAgentsStore = create<AgentsStore>((set) => ({
  availability: {},
  probed: false,
  refresh: async () => {
    set({ probed: false });
    try {
      const availability = await getAgentAvailability(AGENT_PRESETS.map((p) => p.command));
      set({ availability, probed: true });
    } catch {
      set({ probed: true });
    }
  },
}));

/** 某个预设是否可用（未探测时视为可用，避免闪烁）。 */
export function isAvailable(
  availability: Record<string, boolean>,
  probed: boolean,
  command: string,
): boolean {
  if (!probed) return true;
  return availability[command] === true;
}
