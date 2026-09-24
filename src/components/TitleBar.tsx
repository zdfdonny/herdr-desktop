/**
 * TitleBar —— 右栏顶部栏（完全自定义，不含任何标题文字）。
 *
 * 左右两栏完全独立，各自有顶部区，中间以分隔线切开。
 * 本组件只负责**右栏**，只保留：
 * - 整条拖拽区（-webkit-app-region: drag）
 * - 右侧主题切换控件
 *
 * 标题与副标题（会话名 / 项目路径）已移除，顶部不再展示任何标题文本。
 * 侧栏的收起/展开按钮在 Sidebar 内部，不在本栏。
 *
 * Windows 下右侧由 titleBarOverlay 提供原生窗口按钮，需预留其宽度。
 */

import { useEffect } from 'react';
import { useResolvedTheme } from '../stores/settingsStore';
import { useSettingsOpen } from '../stores/uiStore';
import { setTitleBarTheme } from '../ipc/client';
import { ThemeSwitch } from './ThemeSwitch';

/** 主题切换配色，与 global.css 的 --bg-app / --text-secondary 对应。 */
const OVERLAY_COLORS = {
  light: { color: '#ffffff', symbolColor: '#1a1a1a' },
  dark: { color: '#0d0d0d', symbolColor: '#d4d4d4' },
} as const;

export function TitleBar() {
  const resolvedTheme = useResolvedTheme();
  const settingsOpen = useSettingsOpen();

  /*
   * 同步原生窗口按钮配色。
   *
   * titleBarOverlay 的颜色由主进程持有，CSS 管不到。
   * 设置弹窗的半透明遮罩同样盖不住原生按钮条（原生绘制在最上层），
   * 因此弹窗打开时把按钮条同步成遮罩压暗后的近似色，关闭时恢复，
   * 否则弹窗四周都变暗、唯独右上角按钮条仍是亮色，视觉上"没有全覆盖"。
   * 原生 overlay 的 color 不支持透明度，只能用不透明近似色：
   * 浅色 = 45% 黑压白（≈#8c8c8c），深色 = 60% 黑压 #0d0d0d（≈#050505）。
   */
  useEffect(() => {
    const base = OVERLAY_COLORS[resolvedTheme];
    if (settingsOpen) {
      const dimmedColor = resolvedTheme === 'dark' ? '#050505' : '#8c8c8c';
      setTitleBarTheme(dimmedColor, base.symbolColor);
    } else {
      setTitleBarTheme(base.color, base.symbolColor);
    }
  }, [resolvedTheme, settingsOpen]);

  return (
    <header className="topbar">
      {/* 空白拖拽区：占满左侧空间，拖动窗口 */}
      <div className="topbar__drag-region" />

      <div className="topbar__actions">
        <ThemeSwitch />
        {/* 原生窗口按钮占位，避免内容被遮挡 */}
        <div className="topbar__overlay-spacer" aria-hidden="true" />
      </div>
    </header>
  );
}
