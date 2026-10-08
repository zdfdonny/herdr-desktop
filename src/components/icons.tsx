/**
 * Icons —— 内联 SVG 图标集。
 *
 * 不用 Unicode 符号：那些字形笔画细、各字符粗细不一致，且随字体变化。
 * SVG 用统一的 stroke-width 保证视觉重量一致，并随 currentColor 继承颜色。
 *
 * 例外：应用品牌标记 IconLogo 用位图（见文件末尾说明），它需要自带底色。
 */

import appIcon from '../assets/app-icon.png';

interface IconProps {
  /** 尺寸（px），默认 16。 */
  size?: number;
  className?: string;
}

const BASE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/**
 * 设置（齿轮 / cog，取自 Feather icons 的 settings 图标）。
 *
 * 旧版图形画成了「圆 + 8 条放射短线」——那实际是太阳，和浅色主题图标
 * 几乎无法区分，因此换成标准齿轮轮廓：外圈 8 齿 + 中心圆孔。
 * 描边风格（stroke 2 / 圆角连接）与本图标集一致。
 */
export function IconSettings({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** 添加（加号）。 */
export function IconPlus({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

/** 分屏（带十字分割线的窗口，2×2 网格）。 */
export function IconSplit({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <line x1="12" y1="3" x2="12" y2="21" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </svg>
  );
}

/** 向左箭头。 */
export function IconArrowLeft({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

/** 向右箭头。 */
export function IconArrowRight({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

/** 向上箭头。 */
export function IconArrowUp({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

/** 向下箭头。 */
export function IconArrowDown({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

/** 关闭（叉）。 */
export function IconClose({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/** 搜索（放大镜）。 */
export function IconSearch({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="20" y1="20" x2="16.2" y2="16.2" />
    </svg>
  );
}

/** 折叠箭头（向下）。收起时由 CSS 旋转 -90° 变为向右。 */
export function IconChevronDown({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function IconChevronUp({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

/** 通用（滑块）。 */
export function IconSliders({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <line x1="4" y1="8" x2="20" y2="8" />
      <line x1="4" y1="16" x2="20" y2="16" />
      <circle cx="9" cy="8" r="2.2" fill="currentColor" />
      <circle cx="15" cy="16" r="2.2" fill="currentColor" />
    </svg>
  );
}

/** 外观（调色板）。 */
export function IconPalette({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <path d="M12 3a9 9 0 1 0 0 18 2 2 0 0 0 1.6-3.2 2 2 0 0 1 1.6-3.2H17a4 4 0 0 0 4-4 9 9 0 0 0-9-7.6z" />
      <circle cx="7.5" cy="11.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="8.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 语言（地球）。 */
export function IconGlobe({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
    </svg>
  );
}

/** 项目（文件夹，取自 Feather 的 folder 图标）。 */
export function IconFolder({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** 集成（连接 / 链环，取自 Feather 的 link 图标）。 */
export function IconIntegrations({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

/** Agent 检测（终端窗口）。 */
export function IconTerminal({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3" />
      <line x1="13" y1="15" x2="17" y2="15" />
    </svg>
  );
}

/** 键盘（用于快捷键帮助 / 设置页的快捷键分区）。 */
export function IconKeyboard({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <line x1="6" y1="10" x2="6" y2="10" />
      <line x1="10" y1="10" x2="10" y2="10" />
      <line x1="14" y1="10" x2="14" y2="10" />
      <line x1="18" y1="10" x2="18" y2="10" />
      <line x1="8" y1="14" x2="16" y2="14" />
    </svg>
  );
}

/** 关于（信息）。 */
export function IconInfo({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      {...BASE}
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 播放（实心三角）。用于「重新启动」停止的 agent。 */
export function IconPlay({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7.5 4.8l12 7.2-12 7.2z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * 重启（顺时针箭头）。用于侧栏中已停止的 agent。
 *
 * 与 IconPlay 的分工：IconPlay 是「状态指示」（这个 agent 是停止的），
 * 本图标是「动作按钮」（点击可重启），两者在侧栏里同时出现，需要区分。
 */
export function IconRestart({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

/**
 * 应用品牌标记 —— 直接使用应用图标 build/icon.png 本身。
 *
 * 这里刻意不再手绘 SVG：旧实现是照着图标描的矢量近似（渐变底 + 白色三角/下划线），
 * 图标实际换成「蓝色圆角方块 + 白色霓虹公牛」后，那段近似就和桌面图标对不上了。
 * 现在改为引用真实位图，顶栏标记与桌面/任务栏图标逐像素一致，
 * 以后换图标只需替换 build/icon.png 并跑 `npm run icon` 同步，无需再维护第二份造型。
 *
 * src/assets/app-icon.png 由 scripts/sync-icon.js 从 build/icon.png 复制而来
 * （渲染层 Vite root 是 src/，root 外的文件 import 不到）。
 *
 * 位图本身自带圆角与底色，CSS 不要再加描边/圆角，否则会在边缘露出深色缝。
 */
export function IconLogo({ size = 18, className }: IconProps) {
  return (
    <img
      src={appIcon}
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
