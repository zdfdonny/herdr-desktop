/**
 * 快捷键模块入口。
 *
 * - shared/shortcuts.ts 是「键位 + 文案」的单一事实源（Main/Renderer 共用）；
 * - dispatch.ts 把动作 id 落到 store / IPC 动作；
 * - paneNavigation.ts 提供可单测的方向导航纯函数。
 */

export { dispatchShortcut } from './dispatch';
export { findAdjacentPaneId } from './paneNavigation';
export { matchShortcut } from './capture';
export type { ShortcutMatch } from './capture';
export type { PaneRect, PaneDirection } from './paneNavigation';
