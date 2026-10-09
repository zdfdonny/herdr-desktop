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
import { useUiStore } from '../stores/uiStore';
import { activateAndReviveView, focusSurvivorBeforeClose } from './viewActivation';

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

  /**
   * 重启该 agent。
   *
   * 先选中它（同点选整行）：启动恢复后 focusedPaneId 为 null，主区域只渲染初始
   * 引导、不渲染任何视图（见 Layout），此时直接重启会让进程在后台被拉起却完全
   * 看不见，看着就像按钮没反应。选中后主区域才会切到它所在的视图。
   *
   * 运行中的 pane 需要确认：主进程会先杀掉现有进程再拉起，
   * agent 当前会话与滚动缓冲会丢失。停止态的没有可丢的东西，直接重启。
   */
  const handleRestart = () => {
    select();
    if (!running) {
      /*
       * select() 里的 focusPane 已让主进程顺带拉起停止态 pane（「选中即恢复」），
       * 因此这次 respawn 通常是空操作：tryRevive 的守卫会因 running 已翻转为
       * true 而直接返回。保留它是为了让重启按钮不依赖那个副作用。
       */
      respawnPane(agent.paneId);
      return;
    }
    useUiStore.getState().openConfirm({
      title: t('agent.restart'),
      message: t('agent.restartConfirm', { name: displayName }),
      confirmLabel: t('agent.restart'),
      onConfirm: () => respawnPane(agent.paneId, true),
    });
  };

  /**
   * 关闭该 agent。
   *
   * 关闭聚焦的 agent 时，先把焦点挪到仍存活的 pane（同视图兄弟，或同项目
   * 第一个），focusPane 会顺带恢复停止态；这样关闭后选中的标签不会停在
   * 「已停止」。关闭非聚焦 agent 则不动焦点。与 SplitView 的 pane 关闭按钮一致。
   */
  const handleClose = () => {
    if (focused) {
      focusSurvivorBeforeClose(agent.paneId);
    }
    closePane(agent.paneId);
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
       * 重启入口。与关闭按钮一样只在 hover 时显形（见 .agent-row__restart）。
       *
       * 运行中点击需要二次确认：主进程会先杀进程再拉起，
       * 该 agent 当前会话与滚动缓冲会丢失，误点代价太大。
       * 停止态则没有可丢的东西，直接重启。
       */}
      <button
        type="button"
        className="agent-row__restart"
        onClick={(e) => {
          e.stopPropagation();
          handleRestart();
        }}
        title={t('agent.restart')}
        aria-label={t('agent.restart')}
      >
        <IconRestart size={12} />
      </button>
      <button
        type="button"
        className="agent-row__close"
        onClick={(e) => {
          e.stopPropagation();
          handleClose();
        }}
        title={t('agent.close')}
        aria-label={t('agent.close')}
      >
        <IconClose size={12} />
      </button>
    </div>
  );
}
