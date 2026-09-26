/**
 * AgentRow —— 项目分组内的单个 agent 行。
 *
 * 风格：紧凑、无边框、hover 高亮，状态点在最左。
 *
 * 停止态（running=false，恢复出的 pane）：整行压暗，状态点换成播放符号，
 * 提示用户该 agent 需要点击「重新启动」才会拉起进程。
 */

import type { ProjectGroupAgent } from '../stores/sessionStore';
import { agentDisplayName } from '../stores/agentSort';
import { StatusDot } from './StatusDot';
import { IconPlay, IconClose, IconRestart } from './icons';
import { useT } from '../i18n';
import { focusPane, closePane, respawnPane } from '../ipc/client';
import { useLayoutStore, viewOfPane } from '../stores/layoutStore';
import { activateAndReviveView } from './viewActivation';

interface AgentRowProps {
  agent: ProjectGroupAgent;
  focused: boolean;
}

export function AgentRow({ agent, focused }: AgentRowProps) {
  const t = useT();
  // 显示名与侧栏排序键共用同一个函数，避免两处漂移导致列表看着乱序
  const displayName = agentDisplayName(agent);
  const subtitle = agent.title ?? agent.paneId;
  const running = agent.running;

  /**
   * 点选 agent：把它所在的视图带到前台，并恢复该视图里所有停止态的智能体
   * （分屏的其他格子一起恢复，而不是各自拆成独立 tab），再交给 Main 更新焦点。
   */
  const select = () => {
    const store = useLayoutStore.getState();
    const view = viewOfPane(store.views, agent.paneId);
    if (view) {
      activateAndReviveView(view, agent.paneId);
    } else {
      // 不在任何视图里（布局丢失等）：只恢复被点选的这个
      focusPane(agent.paneId);
    }
  };

  return (
    <div
      className={`agent-row ${focused ? 'agent-row--focused' : ''} ${
        running ? '' : 'agent-row--stopped'
      }`}
      onClick={select}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
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
      {/*
       * 停止态的重启入口。
       *
       * 原先这个动作在主区域的「智能体已停止」整页提示里，那个页面已去掉，
       * 入口移到这里——侧栏本来就列出了所有 agent，是更自然的起点。
       * 只在停止时出现，运行中的行不显示（没有可重启的东西）。
       */}
      {!running && (
        <button
          type="button"
          className="agent-row__restart"
          onClick={(e) => {
            e.stopPropagation();
            respawnPane(agent.paneId);
          }}
          title={t('agent.restart')}
          aria-label={t('agent.restart')}
        >
          <IconRestart size={12} />
        </button>
      )}
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
