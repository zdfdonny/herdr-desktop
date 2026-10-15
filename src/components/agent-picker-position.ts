/**
 * AgentPicker 浮窗定位计算（纯函数，便于单测）。
 *
 * 背景：侧栏项目多时列表会滚动，「+」按钮可能贴近窗口底部；浮窗若固定向下弹出，
 * 下半部分会落到可视区之外（fixed 定位虽不受侧栏 overflow 裁剪，但会被窗口边缘
 * 截断，表现为「弹窗显示不全」）。因此这里按「+」按钮上/下方的可用空间决定弹出
 * 方向，并把最大高度夹在所选方向的可用空间内，剩余条目由浮窗自身滚动呈现。
 *
 * 列表高度随已安装智能体数量变化，无法在弹出前预知：首帧用 PICKER_ASSUMED_HEIGHT
 * 兜底，随后由调用方用实测内容高度复算一次（见 ProjectGroup 的 useLayoutEffect）。
 */

/** 浮窗宽度，需与 CSS .agent-picker-popover 一致。 */
export const PICKER_WIDTH = 232;
/** 浮窗与「+」按钮之间的间距。 */
export const PICKER_GAP = 4;
/** 浮窗与窗口边缘的最小留白。 */
export const PICKER_MARGIN = 8;
/** 首帧尚不知内容高度时的假定高度（约 8 个智能体条目）。 */
export const PICKER_ASSUMED_HEIGHT = 240;
/** 极端矮窗口下的兜底最小高度，保证浮窗至少能滚动浏览。 */
export const PICKER_MIN_HEIGHT = 72;

/** 浮窗锚点：向下弹出用 top，向上弹出用 bottom，两者互斥。 */
export interface PickerAnchor {
  /** 距窗口左边缘的距离（fixed 定位）。 */
  left: number;
  /** 向下弹出时距窗口上边缘的距离。 */
  top?: number;
  /** 向上弹出时距窗口下边缘的距离。 */
  bottom?: number;
  /** 夹在可视区内的最大高度。 */
  maxHeight: number;
}

export interface PickerAnchorInput {
  /** 「+」按钮的视口矩形。 */
  button: { top: number; bottom: number; right: number };
  /** 侧栏内容页（.sidebar__panel）的视口矩形；缺失时退化为按按钮右缘居中。 */
  panel?: { left: number; width: number } | null;
  viewportWidth: number;
  viewportHeight: number;
  /** 浮窗内容的自然高度（未夹取前）；首帧未知时省略。 */
  contentHeight?: number;
}

/**
 * 计算浮窗锚点。
 *
 * 水平方向居中于侧栏内容页（而非贴靠「+」按钮），再夹在窗口内；
 * 垂直方向优先向下弹出，下方放不下且上方更宽裕时向上翻转。
 */
export function computePickerAnchor(input: PickerAnchorInput): PickerAnchor {
  const { button, panel, viewportWidth, viewportHeight, contentHeight } = input;

  const centerX = panel ? panel.left + panel.width / 2 : button.right;
  const left = Math.max(
    PICKER_MARGIN,
    Math.min(centerX - PICKER_WIDTH / 2, viewportWidth - PICKER_WIDTH - PICKER_MARGIN),
  );

  const spaceBelow = viewportHeight - button.bottom - PICKER_GAP - PICKER_MARGIN;
  const spaceAbove = button.top - PICKER_GAP - PICKER_MARGIN;
  // 已知内容高度则按「下方放不下」判断，否则用假定高度兜底。
  const needed = contentHeight && contentHeight > 0 ? contentHeight : PICKER_ASSUMED_HEIGHT;
  const openUp = spaceBelow < needed && spaceAbove > spaceBelow;
  const maxHeight = Math.max(openUp ? spaceAbove : spaceBelow, PICKER_MIN_HEIGHT);

  return openUp
    ? { left, bottom: viewportHeight - button.top + PICKER_GAP, maxHeight }
    : { left, top: button.bottom + PICKER_GAP, maxHeight };
}
