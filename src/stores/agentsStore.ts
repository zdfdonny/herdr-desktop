/**
 * agents store —— agent 命令清单与可用性。
 *
 * Agent 选择体验：只突出显示本机真实可用的 agent，
 * 未安装的给出明确提示而不是让 spawn 失败。
 *
 * **预设清单从 `shared/agents` 的注册表派生**，不再手写第二份目录。
 * 重构前这里有 26 条字面量、与主进程的 5 张表平行维护，任何一侧漏改都会
 * 让「渲染端能选、主进程认不出」这类问题静默发生。
 */

import { allAgents } from '@shared/agents/registry';
import type { HostEnv } from '@shared/agents/spec/host';
import { TERMINAL_PRESET_ID } from '@shared/agents/agent-id';
import { create } from 'zustand';
import { getAgentAvailability } from '../ipc/client';
import { isMac, isWindows } from '../platform';
import { compareAgentNames } from './agentSort';

export interface AgentPreset {
  /** 稳定标识（智能体用 canonical id；普通终端用 `terminal`）。 */
  id: string;
  /** 展示名（品牌名，通常不翻译）。 */
  label: string;
  /** 启动命令（web 预设仅用于可用性探测，实际启动走 spawnWebAgent）。 */
  command: string;
  /** 创建方式：普通终端进程（默认）或内嵌 Web GUI。 */
  kind?: 'pty' | 'web';
}

/**
 * 渲染进程的宿主环境。
 *
 * 只用于解析**启动命令**（`cursor` 在 Windows 上是 `.cmd` 垫片、普通终端取平台
 * 默认 shell），不涉及任何路径拼接 —— 所以 `home` 与 `env` 留空即可。
 */
const RENDERER_HOST: HostEnv = {
  platform: isWindows ? 'win32' : isMac ? 'darwin' : 'linux',
  env: {},
  home: '',
};

/**
 * 普通终端预设的启动命令（按平台）。
 *
 * 这是桌面端自有预设，不属于任何智能体：
 * - Windows：PowerShell（不存在时主进程会回退到 ComSpec）
 * - macOS / Linux：由主进程 `resolveDefaultShell()` 解析登录 shell
 *
 * 这里用平台默认值占位，实际启动时主进程的 `defaultShellCommand()` 会兜底，
 * 因此即使该命令在本机解析不到，终端预设依然可用。
 */
const TERMINAL_COMMAND = isWindows ? 'powershell.exe' : isMac ? '/bin/zsh' : '/bin/bash';

/**
 * 全部可创建的预设 = 智能体注册表 + 普通终端。
 *
 * 说明：主进程与渲染进程共用同一份 descriptor，因此两侧的 id / 展示名 /
 * 启动命令不可能漂移（重构前渲染端是自己那份 26 条字面量）。
 */
const PRESETS_UNSORTED: AgentPreset[] = [
  ...allAgents().map((descriptor) => {
    const preset: AgentPreset = {
      id: descriptor.id,
      label: descriptor.label,
      command: descriptor.command(RENDERER_HOST),
    };
    if (descriptor.hosting === 'web') preset.kind = 'web';
    return preset;
  }),
  { id: TERMINAL_PRESET_ID, label: 'Terminal', command: TERMINAL_COMMAND },
];

/*
 * 按 label 排序。用 localeCompare（与侧栏 agent 列表同一规则）而非 `<`：
 * 直接比码点会把大写全排在小写前，且数字段无法自然排序。
 * 同名时回退 id 保证稳定。
 */
export const AGENT_PRESETS: AgentPreset[] = [...PRESETS_UNSORTED].sort(
  (a, b) => compareAgentNames(a.label, b.label) || a.id.localeCompare(b.id),
);

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
