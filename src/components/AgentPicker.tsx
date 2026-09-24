/**
 * AgentPicker —— agent 选择列表（预设 + 本机可用性探测）。
 *
 * 从侧栏 ProjectGroup 抽出复用：主区域「选择项目」视图里，
 * 还没有 agent 的项目卡片也用同一列表就地创建。
 *
 * 只显示本机已安装的智能体：未安装的预设直接过滤掉。
 * 未探测完成前显示提示，避免先列出全部再收缩的闪烁。
 */

import { AGENT_PRESETS, useAgentsStore } from '../stores/agentsStore';
import { spawnAgent } from '../ipc/client';
import { useT } from '../i18n';

interface AgentPickerProps {
  /** 在哪个项目内创建 agent。 */
  projectId: string;
  /** 选中后回调（通常用于关闭选择列表）。 */
  onPick?: () => void;
}

export function AgentPicker({ projectId, onPick }: AgentPickerProps) {
  const t = useT();
  const availability = useAgentsStore((s) => s.availability);
  const probed = useAgentsStore((s) => s.probed);

  // 只保留本机已安装的智能体；终端预设按平台解析默认 shell，通常恒可用。
  const installed = AGENT_PRESETS.filter(
    (preset) => probed && availability[preset.command] === true,
  );

  if (installed.length === 0) {
    return (
      <div className="agent-picker agent-picker--empty">
        {t(probed ? 'agent.noneInstalled' : 'agent.probing')}
      </div>
    );
  }

  return (
    <div className="agent-picker">
      {installed.map((preset) => (
        <button
          key={preset.id}
          type="button"
          className="agent-picker__item"
          onClick={() => {
            spawnAgent(projectId, preset.command, { label: preset.label });
            onPick?.();
          }}
        >
          <span className="agent-picker__label">{preset.label}</span>
        </button>
      ))}
    </div>
  );
}
