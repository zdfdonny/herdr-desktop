/**
 * AgentRow —— 项目分组内的单个 agent 行。
 *
 * 风格：紧凑、无边框、hover 高亮，状态点在最左。
 *
 * 停止态（running=false，恢复出的 pane）：整行压暗，状态点换成播放符号，
 * 提示用户该 agent 需要点击「重新启动」才会拉起进程。
 */

import type { ProjectGroupAgent } from '../stores/sessionStore';
import { StatusDot } from './StatusDot';
import { IconPlay, IconClose } from './icons';
import { useT } from '../i18n';
import { focusPane, closePane } from '../ipc/client';

interface AgentRowProps {
  agent: ProjectGroupAgent;
  focused: boolean;
}

export function AgentRow({ agent, focused }: AgentRowProps) {
  const t = useT();
  const displayName = agent.label ?? agent.name ?? 'agent';
  const subtitle = agent.title ?? agent.paneId;
  const running = agent.running;

  return (
    <div
      className={`agent-row ${focused ? 'agent-row--focused' : ''} ${
        running ? '' : 'agent-row--stopped'
      }`}
      onClick={() => focusPane(agent.paneId)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          focusPane(agent.paneId);
        }
      }}
      title={running ? subtitle : t('agent.stopped')}
    >
      {running ? (
        <StatusDot status={agent.status} />
      ) : (
        <span className="agent-row__stopped-icon" aria-hidden="true">
          <IconPlay size={11} />
        </span>
      )}
      <div className="agent-row__body">
        <span className="agent-row__name">{displayName}</span>
      </div>
      <button
        type="button"
        className="agent-row__close"
        onClick={(e) => {
          e.stopPropagation();
          closePane(agent.paneId);
        }}
        title={t('agent.close')}
        aria-label={t('agent.close')}
      >
        <IconClose size={12} />
      </button>
    </div>
  );
}
