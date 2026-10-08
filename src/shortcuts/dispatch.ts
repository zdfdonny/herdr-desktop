/**
 * 快捷键分发 —— 把菜单转发的动作 id 落到具体 store / IPC 动作上。
 *
 * 菜单 accelerator 由主进程拦截后经 `ui:shortcut` 消息转发到渲染层，
 * 这里只做「动作 id → 函数」的映射，保证乐观更新与 DOM 副作用一致。
 */

import type { ShortcutActionId } from '@shared/shortcuts';
import { useLayoutStore, flattenLayout, type FlatLeaf } from '../stores/layoutStore';
import { useSessionStore } from '../stores/sessionStore';
import { useUiStore } from '../stores/uiStore';
import { focusPane, closePane } from '../ipc/client';
import {
  activeProjectView,
  activateAdjacentView,
  activateViewByIndex,
  closeViewTab,
  focusSurvivorBeforeClose,
} from '../components/viewActivation';
import { findAdjacentPaneId, type PaneDirection, type PaneRect } from './paneNavigation';

function focusedPaneId(): string | null {
  return useSessionStore.getState().state.focusedPaneId;
}

/** 在当前聚焦 pane 的右/下方开一个空位分屏。 */
function splitFocusedPane(direction: 'right' | 'down'): void {
  const paneId = focusedPaneId();
  if (!paneId) return;
  const pane = useSessionStore.getState().state.panes.find((p) => p.paneId === paneId);
  if (!pane) return;
  useLayoutStore.getState().splitPane(paneId, direction, pane.projectId);
}

/** 关闭聚焦 pane（先转移焦点到幸存兄弟，避免关闭后标签跳走）。 */
function closeFocusedPane(): void {
  const paneId = focusedPaneId();
  if (!paneId) return;
  focusSurvivorBeforeClose(paneId);
  closePane(paneId);
}

/** 把焦点移动到指定方向的相邻 pane。 */
function focusPaneInDirection(direction: PaneDirection): void {
  const paneId = focusedPaneId();
  if (!paneId) return;
  const { views, activeViewId } = useLayoutStore.getState();
  const view = views.find((v) => v.id === activeViewId);
  if (!view?.tree) return;

  const leaves: PaneRect[] = flattenLayout(view.tree).leaves
    .filter((leaf): leaf is FlatLeaf & { type: 'pane' } => leaf.type === 'pane')
    .map((leaf) => ({ paneId: leaf.paneId, x: leaf.x, y: leaf.y, w: leaf.w, h: leaf.h }));

  const target = findAdjacentPaneId(paneId, direction, leaves);
  if (target) focusPane(target);
}

export function dispatchShortcut(action: ShortcutActionId, index?: number): void {
  switch (action) {
    case 'help':
      useUiStore.getState().toggleShortcutHelp();
      break;
    case 'new-tab': {
      /*
       * 新建标签 = 新建一个只含空位的视图（与分屏空位一样显示 AgentPicker），
       * 用户选择智能体后由 reconcile 填空位。项目取聚焦 pane 的项目；
       * 未选中任何 pane（没有当前项目）时不生效。
       */
      const state = useSessionStore.getState().state;
      const focused = state.panes.find((p) => p.paneId === state.focusedPaneId);
      if (focused) useLayoutStore.getState().newEmptyView(focused.projectId);
      break;
    }
    case 'next-tab':
      activateAdjacentView(1);
      break;
    case 'previous-tab':
      activateAdjacentView(-1);
      break;
    case 'switch-tab':
      if (index !== undefined) activateViewByIndex(index - 1);
      break;
    case 'close-tab': {
      const view = activeProjectView();
      if (view) closeViewTab(view);
      break;
    }
    case 'rename-tab': {
      const view = activeProjectView();
      if (view) useUiStore.getState().startRenameView(view.id);
      break;
    }
    case 'split-vertical':
      splitFocusedPane('right');
      break;
    case 'split-horizontal':
      splitFocusedPane('down');
      break;
    case 'close-pane':
      closeFocusedPane();
      break;
    case 'focus-pane-left':
      focusPaneInDirection('left');
      break;
    case 'focus-pane-down':
      focusPaneInDirection('down');
      break;
    case 'focus-pane-up':
      focusPaneInDirection('up');
      break;
    case 'focus-pane-right':
      focusPaneInDirection('right');
      break;
    default:
      break;
  }
}
