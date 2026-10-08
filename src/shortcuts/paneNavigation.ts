/**
 * 分屏窗格的方向导航 —— 纯函数，无副作用，便于单元测试。
 *
 * 输入是「已展平的叶子矩形」（0–1 比例坐标，见 layoutStore.flattenLayout），
 * 输出目标 paneId。规则：
 * - 候选 pane 必须整体位于聚焦 pane 的该方向一侧（如 left：候选右缘 ≤ 聚焦左缘）；
 * - 优先选正交轴上有重叠的候选；重叠越大越优先；
 * - 重叠相同时，主轴距离越近越优先。
 */

export interface PaneRect {
  paneId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PaneDirection = 'left' | 'right' | 'up' | 'down';

const EPSILON = 1e-9;

export function findAdjacentPaneId(
  focusedId: string,
  direction: PaneDirection,
  panes: readonly PaneRect[],
): string | null {
  const focused = panes.find((p) => p.paneId === focusedId);
  if (!focused) return null;

  let bestId: string | null = null;
  let bestOverlap = -1;
  let bestDistance = Infinity;

  for (const pane of panes) {
    if (pane.paneId === focusedId) continue;
    if (!isOnSide(focused, pane, direction)) continue;

    const overlap = orthogonalOverlap(focused, pane, direction);
    const distance = primaryDistance(focused, pane, direction);
    if (overlap > bestOverlap || (overlap === bestOverlap && distance < bestDistance)) {
      bestOverlap = overlap;
      bestDistance = distance;
      bestId = pane.paneId;
    }
  }

  return bestId;
}

/** 候选 pane 是否整体位于聚焦 pane 的指定方向一侧。 */
function isOnSide(focused: PaneRect, pane: PaneRect, direction: PaneDirection): boolean {
  switch (direction) {
    case 'left':
      return pane.x + pane.w <= focused.x + EPSILON;
    case 'right':
      return pane.x >= focused.x + focused.w - EPSILON;
    case 'up':
      return pane.y + pane.h <= focused.y + EPSILON;
    case 'down':
      return pane.y >= focused.y + focused.h - EPSILON;
  }
}

/** 正交轴重叠长度（left/right 的垂直重叠；up/down 的水平重叠）。 */
function orthogonalOverlap(focused: PaneRect, pane: PaneRect, direction: PaneDirection): number {
  if (direction === 'left' || direction === 'right') {
    const lo = Math.max(focused.y, pane.y);
    const hi = Math.min(focused.y + focused.h, pane.y + pane.h);
    return Math.max(0, hi - lo);
  }
  const lo = Math.max(focused.x, pane.x);
  const hi = Math.min(focused.x + focused.w, pane.x + pane.w);
  return Math.max(0, hi - lo);
}

/** 主轴间距（两矩形在移动方向上的间隙）。 */
function primaryDistance(focused: PaneRect, pane: PaneRect, direction: PaneDirection): number {
  switch (direction) {
    case 'left':
      return focused.x - (pane.x + pane.w);
    case 'right':
      return pane.x - (focused.x + focused.w);
    case 'up':
      return focused.y - (pane.y + pane.h);
    case 'down':
      return pane.y - (focused.y + focused.h);
  }
}
