/**
 * TitleBar —— 窗口标题栏（横贯整个窗口宽度，位于所有面板之上）。
 *
 * 布局从左到右：
 *   应用图标 + 应用名 → 折叠/展开按钮 → 弹性拖拽区 → 主题切换 → 原生窗口按钮占位
 *
 * 这里是**唯一**放置应用标识与侧栏折叠按钮的地方。
 * 侧栏/项目列表是独立的一块圆角卡片，不再承载品牌行——
 * 图标、名字、折叠按钮都不属于项目列表。
 *
 * Windows 下右侧由 titleBarOverlay 提供原生窗口按钮，需预留其宽度；
 * macOS 交通灯在左侧，由 --mac-traffic-light-inset 让位。
 */

import { useEffect } from 'react';
import { useResolvedTheme, useSettingsStore } from '../stores/settingsStore';
import { useSettingsOpen } from '../stores/uiStore';
import { setTitleBarTheme } from '../ipc/client';
import { useT } from '../i18n';
import { ThemeSwitch } from './ThemeSwitch';
import { IconLogo, IconPanelLeft } from './icons';

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
  const collapsed = useSettingsStore((s) => s.settings.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore((s) => s.setSidebarCollapsed);

  /*
   * 同步原生窗口按钮配色。
   *
   * titleBarOverlay 的颜色由主进程持有，CSS 管不到。
   * 设置弹窗的半透明遮罩同样盖不住原生按钮条（原生绘制在最上层），
   * 因此弹窗打开时把按钮条同步成遮罩压暗后的近似色，关闭时恢复，
   * 否则弹窗四周都变暗、唯独右上角按钮条仍是亮色，视觉上"没有全覆盖"。
   * 原生 overlay 的 color 不支持透明度，只能用不透明近似色：
   * 浅色 = 45% 黑压 #fafafd（≈#8a8a8c），深色 = 60% 黑压 #0d0d0d（≈#050505）。
   */
  useEffect(() => {
    const base = OVERLAY_COLORS[resolvedTheme];
    if (settingsOpen) {
      const dimmedColor = resolvedTheme === 'dark' ? '#050505' : '#8a8a8c';
      setTitleBarTheme(dimmedColor, base.symbolColor);
    } else {
      setTitleBarTheme(base.color, base.symbolColor);
    }
  }, [resolvedTheme, settingsOpen]);

  return (
    <header className="topbar">
      {/* 品牌区：应用图标 + 应用名，让出 macOS 交通灯位置 */}
      <div className="topbar__brand">
        <span className="topbar__brand-mark" aria-hidden="true">
          <IconLogo size={18} />
        </span>
        <span className="topbar__brand-name">{t('app.name')}</span>
      </div>

      {/*
       * 折叠/展开按钮：紧跟在应用名之后。
       * 父级 .topbar 是 drag 区，按钮必须显式 no-drag，否则点击会被吞掉。
       * 图标始终朝左，收起/展开两态用同一个按钮，位置不跳动。
       */}
      <button
        type="button"
        className="icon-button topbar__toggle"
        onClick={() => setSidebarCollapsed(!collapsed)}
        title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
      >
        <IconPanelLeft size={15} />
      </button>

      {/* 弹性拖拽区：占满中间剩余空间，拖动窗口 */}
      <div className="topbar__drag-region" />

      <div className="topbar__actions">
        <ThemeSwitch />
        {/* 原生窗口按钮占位，避免内容被遮挡 */}
        <div className="topbar__overlay-spacer" aria-hidden="true" />
      </div>
    </header>
  );
}
