/**
 * Layout —— 主布局：窗口标题栏 + 左侧栏卡片 + 主区卡片 + 设置弹窗 + 通知浮层。
 *
 * 采用浮动面板布局：
 * - 最上方是一条横贯整个窗口宽度的 TitleBar，承载应用图标/名字/折叠按钮/主题切换；
 * - 下方 .layout__body 里，侧栏与主区各自是一块带圆角的独立卡片，
 *   卡片之间以及与窗口边缘之间留出 --panel-gap 的间隙，露出窗口底色。
 *
 * 主区内容由 layoutStore 的**视图**驱动：
 * - 未选中任何智能体（focusedPaneId 为 null）→ 初始引导，不自动展示布局；
 * - 选中智能体后 → 显示其所在视图的 SplitView 分屏树（停止态 pane 就地提示重启）；
 * - 选中的智能体不在任何视图里（布局丢失等）→ 全屏显示重启提示/终端。
 */

import type { ReactNode } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsOpen } from '../stores/uiStore';
import { useLayoutStore } from '../stores/layoutStore';
import { TitleBar } from './TitleBar';
import { Sidebar } from './Sidebar';
import { TerminalPane } from './TerminalPane';
import { WebPane } from './WebPane';
import { SplitView } from './SplitView';
import { ViewTabs } from './ViewTabs';
import { SettingsDialog } from './SettingsDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { EmptyState } from './EmptyState';
import { NotificationToasts } from './NotificationToasts';
import { isMac } from '../platform';

export function Layout() {
  const state = useSessionStore((s) => s.state);
  const settingsOpen = useSettingsOpen();
  const views = useLayoutStore((s) => s.views);
  const activeViewId = useLayoutStore((s) => s.activeViewId);

  /*
   * 严格按 focusedPaneId 查找，不做「退回第一个 pane」的兜底：
   * 启动恢复后不选中任何 agent（focusedPaneId 为 null），
   * 主区域此时应显示初始空状态，而不是自动展示某个 pane。
   */
  const focusedPane =
    state.panes.find((p) => p.paneId === state.focusedPaneId) ?? null;
  /*
   * 全部 pane（含停止态）都进入分屏树渲染：
   * 停止态 pane 在各自的分屏格内显示「重新启动」提示，而不是整体消失。
   * 只有真正从会话里消失的 pane 才会被 reconcile 剪掉。
   */
  const panesById = new Map(state.panes.map((p) => [p.paneId, p]));

  const activeView = views.find((v) => v.id === activeViewId) ?? views[0] ?? null;

  // 选中智能体后才展示分屏布局；未选中时即使布局树里还有停止态 pane 也显示引导
  const showingViews = focusedPane !== null && views.length > 0;

  let content: ReactNode;
  if (!focusedPane) {
    // 未选中任何智能体（应用重启后的初始状态）→ 引导，不要自动恢复
    content = <EmptyState />;
  } else if (showingViews) {
    /*
     * 所有视图保持挂载，只切换可见性。
     *
     * 这很关键：Electron 的 <webview> guest 一旦从 DOM 移除（卸载）或 reparent
     * 就会被销毁重建，导致切换标签页时 DSH Web GUI 整页重载。这里让每个视图都
     * 常驻在各自的 .view-layer 里，切标签只改 display，webview 始终待在原容器，
     * 页面与会话不中断。
     */
    content = (
      <>
        {views.map((v) => {
          const active = v.id === activeViewId;
          return (
            <div
              key={v.id}
              className={`view-layer${active ? ' view-layer--active' : ''}`}
              aria-hidden={!active}
            >
              {v.tree && (
                <SplitView
                  node={v.tree}
                  panes={panesById}
                  focusedPaneId={state.focusedPaneId}
                />
              )}
            </div>
          );
        })}
      </>
    );
  } else {
    // 选中的智能体不在任何视图里（布局丢失等）：全屏显示重启提示/终端
    content =
      focusedPane.kind === 'web' ? (
        <WebPane pane={focusedPane} />
      ) : (
        <TerminalPane pane={focusedPane} />
      );
  }

  return (
    <div className={`layout ${isMac ? 'layout--mac' : ''}`}>
      {/* 窗口标题栏：横贯整宽，位于所有面板之上 */}
      <TitleBar />
      <div className="layout__body">
        <Sidebar />
        <main className="layout__main">
          {showingViews && views.length > 1 && (
            <ViewTabs views={views} activeViewId={activeView?.id ?? null} />
          )}
          <div className="layout__content">{content}</div>
        </main>
      </div>
      {settingsOpen && <SettingsDialog />}
      <ConfirmDialog />
      <NotificationToasts />
    </div>
  );
}
