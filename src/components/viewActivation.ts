/**
 * 视图激活 + 停止态智能体恢复。
 *
 * 两条入口共用的动作：
 * - 侧栏点选智能体（AgentRow）；
 * - 点击视图标签（ViewTabs）。
 *
 * 语义：把焦点挪进目标视图，并恢复该视图（分屏）里**所有**停止态的智能体，
 * 而不是只恢复被点选的那一个——否则分屏的其他格子会停在「已停止」，
 * 布局丢失时还会被拆成各自独立的 tab。
 */

import { useLayoutStore, viewPaneIds, type View } from '../stores/layoutStore';
import { useSessionStore } from '../stores/sessionStore';
import { focusPane, respawnPane } from '../ipc/client';

export function activateAndReviveView(view: View, focusedPaneId: string): void {
  // 先激活视图，给出即时的视觉反馈
  useLayoutStore.getState().activateView(view.id);
  // focusPane 对停止态 pane 会自动 revive，同时把焦点挪进本视图
  //（否则 reconcile 的焦点跟随会在下一次快照时把视图顶回旧 tab）
  focusPane(focusedPaneId);
  // 分屏里其余停止态的智能体也要一起恢复，不显示「已停止」提示
  const panes = useSessionStore.getState().state.panes;
  for (const id of viewPaneIds(view)) {
    if (id === focusedPaneId) continue;
    const pane = panes.find((p) => p.paneId === id);
    if (pane && pane.running === false) {
      respawnPane(id);
    }
  }
}
