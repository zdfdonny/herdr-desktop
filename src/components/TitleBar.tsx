/**
 * TitleBar —— 窗口标题栏（横贯整个窗口宽度，位于所有面板之上）。
 *
 * 布局从左到右：
 *   应用图标 + 应用名 → 弹性拖拽区 → 原生窗口按钮占位
 *
 * 标题栏只承载应用标识；主题切换与侧栏折叠按钮已移除，
 * 侧栏现在由自身的图标栏负责展开/收起。
 *
 * Windows 下右侧由 titleBarOverlay 提供原生窗口按钮，需预留其宽度；
 * macOS 交通灯在左侧，由 --mac-traffic-light-inset 让位。
 */

import { useEffect } from 'react';
import { useResolvedTheme } from '../stores/settingsStore';
import { useSettingsOpen, useUiStore } from '../stores/uiStore';
import { setTitleBarTheme } from '../ipc/client';
import { useT } from '../i18n';
import { IconLogo } from './icons';

/**
 * 原生窗口按钮配色，必须与 global.css 的 --bg-app 完全一致。
 *
 * titleBarOverlay 由主进程用不透明色绘制在窗口最上层，CSS 完全覆盖不到。
 * 标题栏与窗口底色同为 --bg-app，若这里取别的颜色，
 * 右上角会多出一条色差明显的按钮条，破坏"标题栏与 app 背景同色"。
 */
const OVERLAY_COLORS = {
  light: { color: '#fafafd', symbolColor: '#3b3b3b' },
  dark: { color: '#0d0d0d', symbolColor: '#cccccc' },
} as const;

export function TitleBar() {
  const t = useT();
  const resolvedTheme = useResolvedTheme();
  const settingsOpen = useSettingsOpen();
  const onboardingOpen = useUiStore((s) => s.integrationsOnboardingOpen);

  /*
   * 同步原生窗口按钮配色。
   *
   * titleBarOverlay 的颜色由主进程持有，CSS 管不到。
   * 设置弹窗/集成引导弹窗的半透明遮罩同样盖不住原生按钮条（原生绘制在最上层），
   * 因此任一弹窗打开时把按钮条同步成遮罩压暗后的近似色，关闭时恢复，
   * 否则弹窗四周都变暗、唯独右上角按钮条仍是亮色，视觉上"没有全覆盖"。
   * 原生 overlay 的 color 不支持透明度，只能用不透明近似色：
   * 浅色 = 45% 黑压 #fafafd（≈#8a8a8c），深色 = 60% 黑压 #0d0d0d（≈#050505）。
   */
  const anyModalOpen = settingsOpen || onboardingOpen;

  useEffect(() => {
    const base = OVERLAY_COLORS[resolvedTheme];
    if (anyModalOpen) {
      const dimmedColor = resolvedTheme === 'dark' ? '#050505' : '#8a8a8c';
      setTitleBarTheme(dimmedColor, base.symbolColor);
    } else {
      setTitleBarTheme(base.color, base.symbolColor);
    }
  }, [resolvedTheme, anyModalOpen]);

  return (
    <header className="topbar">
      {/* 品牌区：应用图标 + 应用名，让出 macOS 交通灯位置 */}
      <div className="topbar__brand">
        <span className="topbar__brand-mark" aria-hidden="true">
          <IconLogo size={18} />
        </span>
        <span className="topbar__brand-name">{t('app.name')}</span>
      </div>

      {/* 弹性拖拽区：占满中间剩余空间，拖动窗口 */}
      <div className="topbar__drag-region" />

      <div className="topbar__actions">
        {/* 原生窗口按钮占位，避免内容被遮挡 */}
        <div className="topbar__overlay-spacer" aria-hidden="true" />
      </div>
    </header>
  );
}
