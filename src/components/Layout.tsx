/**
 * Layout —— 主布局：左侧栏 + 右主区（各自有顶部栏）+ 设置弹窗 + 通知浮层。
 *
 * 左右两栏完全独立，中间由侧栏的右边框分隔，
 * 没有横跨整宽的标题栏。侧栏顶部是品牌区，主区顶部是主题切换。
 *
 * 主区内容：
 * - 多个运行中的 agent → 水平并排（多 pane 分屏，herdr 的核心价值）；
 * - 单个运行中的 agent → 占满主区（与之前一致）；
 * - 无运行 agent 但聚焦了某个停止态 pane → 显示重启提示；
 * - 否则 → 初始空状态。
 */

import type { ReactNode } from 'react';
import type { PaneState } from '@shared/state';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsOpen } from '../stores/uiStore';
import { TitleBar } from './TitleBar';
import { Sidebar } from './Sidebar';
import { TerminalPane } from './TerminalPane';
import { SettingsDialog } from './SettingsDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { EmptyState } from './EmptyState';
import { NotificationToasts } from './NotificationToasts';
import { focusPane, closePane } from '../ipc/client';
import { useT } from '../i18n';
import { IconClose } from './icons';

export function Layout() {
  const state = useSessionStore((s) => s.state);
  const settingsOpen = useSettingsOpen();
  /*
   * 严格按 focusedPaneId 查找，不做「退回第一个 pane」的兜底：
   * 启动恢复后不选中任何 agent（focusedPaneId 为 null），
   * 主区域此时应显示初始空状态，而不是自动展示某个 pane。
   */
  const focusedPane =
    state.panes.find((p) => p.paneId === state.focusedPaneId) ?? null;
  // running 是可选字段（旧快照缺省视为运行中），false 才表示停止态
  const runningPanes = state.panes.filter((p) => p.running !== false);

  let content: ReactNode;
  if (runningPanes.length > 1) {
    content = (
      <div className="pane-grid">
        {runningPanes.map((pane) => (
          <PaneCell
            key={pane.paneId}
            pane={pane}
            focused={pane.paneId === state.focusedPaneId}
          />
        ))}
      </div>
    );
  } else if (runningPanes.length === 1) {
    content = <TerminalPane pane={runningPanes[0]} />;
  } else if (focusedPane) {
    // 聚焦了停止态 pane（恢复失败等）：显示重启提示
    content = <TerminalPane pane={focusedPane} />;
  } else {
    content = <EmptyState />;
  }

  return (
    <div className="layout">
      <div className="layout__body">
        <Sidebar />
        <main className="layout__main">
          <TitleBar />
          <div className="layout__content">{content}</div>
        </main>
      </div>
      {settingsOpen && <SettingsDialog />}
      <ConfirmDialog />
      <NotificationToasts />
    </div>
  );
}

/**
 * PaneCell —— 分屏中的一个 agent 列。
 *
 * 顶部是一条细标签栏（点击聚焦 + 关闭按钮），下面挂一个独立 xterm 实例。
 * 每个 TerminalPane 自己按 paneId 订阅 terminalBus，数据互不串扰。
 */
function PaneCell({ pane, focused }: { pane: PaneState; focused: boolean }) {
  const t = useT();
  return (
    <div className={`pane-cell ${focused ? 'pane-cell--focused' : ''}`}>
      <div
        className="pane-cell__header"
        onClick={() => focusPane(pane.paneId)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            focusPane(pane.paneId);
          }
        }}
      >
        <span className="pane-cell__label">{pane.label ?? pane.paneId}</span>
        <button
          type="button"
          className="pane-cell__close"
          onClick={(e) => {
            e.stopPropagation();
            closePane(pane.paneId);
          }}
          title={t('agent.close')}
          aria-label={t('agent.close')}
        >
          <IconClose size={12} />
        </button>
      </div>
      <div className="pane-cell__body">
        <TerminalPane pane={pane} />
      </div>
    </div>
  );
}
