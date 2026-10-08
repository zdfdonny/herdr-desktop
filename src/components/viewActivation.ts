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
 *
 * 也提供「关闭聚焦 pane 前先转移焦点到幸存 pane」的辅助函数，让关闭动作
 * 选中的新标签如果原本是停止态，也能被 focusPane 自动拉起。
 */

import {
  useLayoutStore,
  viewOfPane,
  viewPaneIds,
  viewProjectId,
  type View,
} from '../stores/layoutStore';
import { useSessionStore } from '../stores/sessionStore';
import { closePane, focusPane, respawnPane } from '../ipc/client';

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

/**
 * 关闭聚焦的 pane 前，把焦点挪到一个仍存活的 pane，并借 focusPane 自动恢复停止态。
 *
 * 这样「关闭当前焦点智能体」后，被选中的标签如果原本是停止态，也会被拉起，
 * 符合「选中标签后自动恢复停止态智能体」的预期。优先级：
 * 1. 同一视图（分屏）里的兄弟 pane → 当前标签继续存活；
 * 2. 同项目剩余的第一个 pane → 选中该项目下的第一个标签；
 * 3. 都没有 → 不动焦点，交给 Main 的 closePane 清空焦点（内容区显示空状态）。
 */
export function focusSurvivorBeforeClose(paneId: string): void {
  const store = useLayoutStore.getState();
  const view = viewOfPane(store.views, paneId);
  const sibling = view ? viewPaneIds(view).find((id) => id !== paneId) : undefined;
  if (sibling) {
    focusPane(sibling);
    return;
  }

  // 无兄弟（整个标签只剩这一个 pane）：聚焦同项目剩余的第一个 pane
  const panes = useSessionStore.getState().state.panes;
  const closing = panes.find((p) => p.paneId === paneId);
  if (!closing) return;
  const next = panes.find((p) => p.projectId === closing.projectId && p.paneId !== paneId);
  if (next) {
    focusPane(next.paneId);
  }
}

/** 当前项目过滤后的可见视图（与 Layout 传给 ViewTabs 的 projectViews 一致）。 */
export function visibleProjectViews(): View[] {
  const { views } = useLayoutStore.getState();
  const state = useSessionStore.getState().state;
  const focusedPane = state.panes.find((p) => p.paneId === state.focusedPaneId) ?? null;
  const currentProjectId = focusedPane?.projectId ?? null;
  if (!currentProjectId) return views;
  const byId = new Map(state.panes.map((p) => [p.paneId, p]));
  return views.filter((v) => viewProjectId(v, byId) === currentProjectId);
}

/** 当前激活的可见视图；无可见视图返回 null。 */
export function activeProjectView(): View | null {
  const views = visibleProjectViews();
  if (views.length === 0) return null;
  const { activeViewId } = useLayoutStore.getState();
  return views.find((v) => v.id === activeViewId) ?? views[0];
}

/** 激活视图并恢复其中停止态智能体（与 ViewTabs 点标签语义一致）。 */
export function activateViewTab(view: View): void {
  const firstId = viewPaneIds(view)[0] ?? null;
  if (firstId) {
    activateAndReviveView(view, firstId);
  } else {
    useLayoutStore.getState().activateView(view.id);
  }
}

/** 按可见顺序激活第 index（0-based）个视图。 */
export function activateViewByIndex(index: number): void {
  const view = visibleProjectViews()[index];
  if (view) activateViewTab(view);
}

/** 按可见顺序切换到上一个/下一个视图（环形）。 */
export function activateAdjacentView(delta: 1 | -1): void {
  const views = visibleProjectViews();
  if (views.length === 0) return;
  const { activeViewId } = useLayoutStore.getState();
  const current = Math.max(0, views.findIndex((v) => v.id === activeViewId));
  const next = (current + delta + views.length) % views.length;
  activateViewTab(views[next]);
}

/**
 * 关闭一个视图标签：先关闭其内所有 pane（杀进程），再收起视图并激活相邻视图。
 * 与 ViewTabs 的 closeTab 语义一致。
 */
export function closeViewTab(view: View): void {
  const { activeViewId } = useLayoutStore.getState();
  const visible = visibleProjectViews();
  const closingActive = activeViewId === view.id;
  const nextView = closingActive ? visible.find((v) => v.id !== view.id) ?? null : null;

  for (const id of viewPaneIds(view)) {
    closePane(id);
  }
  useLayoutStore.getState().closeView(view.id, nextView?.id ?? null);

  if (closingActive && nextView) {
    activateViewTab(nextView);
  }
}
