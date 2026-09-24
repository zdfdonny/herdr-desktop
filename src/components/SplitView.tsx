/**
 * SplitView —— 分屏布局树的渲染。
 *
 * 布局树先被 flattenLayout 展平成一组绝对定位的矩形（叶子 + 分隔条），
 * 然后在一个容器里平铺渲染。这样每个叶子都是同一容器的直接子节点，
 * 用稳定的 key 保持 React 组件身份：布局变化（分屏/关闭/折叠）时，
 * 存活 pane 的 xterm 不会被卸载重建，避免终端闪烁与滚动复位。
 *
 * - PaneLeaf → PaneCell（标题栏 + xterm）；
 * - EmptyLeaf → EmptySlot（等待用户选择智能体填充）；
 * - SplitNode → 一条可拖动的分隔条。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import type { PaneState } from '@shared/state';
import {
  useLayoutStore,
  findSplitNode,
  flattenLayout,
  DIVIDER_SIZE,
  type LayoutNode,
  type FlatLeaf,
  type FlatDivider,
  type SplitDirection,
} from '../stores/layoutStore';
import { focusPane, closePane } from '../ipc/client';
import { useT } from '../i18n';
import { TerminalPane } from './TerminalPane';
import { AgentPicker } from './AgentPicker';
import { IconClose, IconSplit } from './icons';
import type { MessageKey } from '../i18n/messages';

/** 分屏菜单的四个方向（文案走 i18n）。 */
const SPLIT_ITEMS: { direction: SplitDirection; labelKey: MessageKey }[] = [
  { direction: 'left', labelKey: 'pane.splitLeft' },
  { direction: 'right', labelKey: 'pane.splitRight' },
  { direction: 'up', labelKey: 'pane.splitUp' },
  { direction: 'down', labelKey: 'pane.splitDown' },
];

interface SplitViewProps {
  node: LayoutNode;
  panes: Map<string, PaneState>;
  focusedPaneId: string | null;
}

export function SplitView({ node, panes, focusedPaneId }: SplitViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const flat = useMemo(() => flattenLayout(node), [node]);

  return (
    <div className="split-root" ref={rootRef}>
      {flat.leaves.map((leaf) => (
        <div
          key={leaf.key}
          className="split-leaf"
          style={{
            left: `${leaf.x * 100}%`,
            top: `${leaf.y * 100}%`,
            width: `${leaf.w * 100}%`,
            height: `${leaf.h * 100}%`,
          }}
        >
          <LeafView leaf={leaf} panes={panes} focusedPaneId={focusedPaneId} />
        </div>
      ))}

      {flat.dividers.map((divider) => (
        <SplitDivider
          key={divider.key}
          divider={divider}
          treeRoot={node}
          rootRef={rootRef}
        />
      ))}
    </div>
  );
}

function LeafView({
  leaf,
  panes,
  focusedPaneId,
}: {
  leaf: FlatLeaf;
  panes: Map<string, PaneState>;
  focusedPaneId: string | null;
}) {
  if (leaf.type === 'pane') {
    const pane = panes.get(leaf.paneId);
    if (!pane) return null;
    return <PaneCell pane={pane} focused={pane.paneId === focusedPaneId} />;
  }
  return <EmptySlot leafId={leaf.key} projectId={leaf.projectId} />;
}

function SplitDivider({
  divider,
  treeRoot,
  rootRef,
}: {
  divider: FlatDivider;
  treeRoot: LayoutNode;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const isRow = divider.orientation === 'row';

  const style: CSSProperties = isRow
    ? {
        left: `${divider.x * 100}%`,
        top: `${divider.y * 100}%`,
        width: `${DIVIDER_SIZE}px`,
        height: `${divider.h * 100}%`,
        transform: `translateX(-${DIVIDER_SIZE / 2}px)`,
      }
    : {
        left: `${divider.x * 100}%`,
        top: `${divider.y * 100}%`,
        width: `${divider.w * 100}%`,
        height: `${DIVIDER_SIZE}px`,
        transform: `translateY(-${DIVIDER_SIZE / 2}px)`,
      };

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const { setRatio } = useLayoutStore.getState();
    const node = findSplitNode(treeRoot, divider.nodeId);
    if (!node) return;

    const root = rootRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const total = isRow
      ? divider.contentW * rootRect.width
      : divider.contentH * rootRect.height;
    if (total <= 0) return;

    const startRatio = node.ratio;
    const startX = e.clientX;
    const startY = e.clientY;

    const onMove = (ev: MouseEvent) => {
      const delta = isRow ? ev.clientX - startX : ev.clientY - startY;
      const next = clamp(((startRatio / 100) * total + delta) / total * 100, 10, 90);
      setRatio(divider.nodeId, next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      className={`split-divider split-divider--${divider.orientation}`}
      style={style}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation={isRow ? 'vertical' : 'horizontal'}
    />
  );
}

function PaneCell({ pane, focused }: { pane: PaneState; focused: boolean }) {
  const t = useT();
  const [splitMenu, setSplitMenu] = useState<{ top: number; left: number } | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const splitButtonRef = useRef<HTMLButtonElement>(null);

  // 分屏方向菜单打开时：点击菜单外、按 Esc 都关闭。
  useEffect(() => {
    if (!splitMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (headerRef.current?.contains(e.target as Node)) return;
      setSplitMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSplitMenu(null);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [splitMenu]);

  const toggleSplitMenu = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (splitMenu) {
      setSplitMenu(null);
      return;
    }
    const rect = splitButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 菜单实际尺寸：4 行文字项 + 间隙 + 内边距（与 .split-menu 样式保持一致）。
    const MENU_WIDTH = 116;
    const MENU_HEIGHT = 4 * 28 + 3 * 2 + 8;
    // 优先右对齐到按钮，再夹在视口内；空间不够时向左展开。
    let left = rect.right - MENU_WIDTH;
    if (left < 8) left = rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - MENU_WIDTH - 8));
    const top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - MENU_HEIGHT - 8));
    setSplitMenu({ top, left });
  };

  const doSplit = (direction: SplitDirection) => {
    useLayoutStore.getState().splitPane(pane.paneId, direction, pane.projectId);
    setSplitMenu(null);
  };

  return (
    <div className={`pane-cell ${focused ? 'pane-cell--focused' : ''}`}>
      <div
        className="pane-cell__header"
        ref={headerRef}
        onClick={() => focusPane(pane.paneId)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            focusPane(pane.paneId);
          }
        }}
      >
        <span className="pane-cell__label">{pane.label ?? pane.paneId}</span>
        <div className="pane-cell__actions">
          <button
            type="button"
            ref={splitButtonRef}
            className="pane-cell__split"
            onClick={toggleSplitMenu}
            title={t('pane.split')}
            aria-label={t('pane.split')}
            aria-expanded={splitMenu !== null}
          >
            <IconSplit size={12} />
          </button>
          <button
            type="button"
            className="pane-cell__close"
            onClick={(e) => {
              e.stopPropagation();
              closePane(pane.paneId);
            }}
            title={t('agent.close')}
            aria-label={t('agent.close')}
          >
            <IconClose size={12} />
          </button>
        </div>

        {splitMenu && (
          <div
            className="split-menu"
            style={{ top: splitMenu.top, left: splitMenu.left }}
            onClick={(e) => e.stopPropagation()}
          >
            {SPLIT_ITEMS.map((item) => (
              <button
                key={item.direction}
                type="button"
                className="split-menu__item"
                onClick={() => doSplit(item.direction)}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="pane-cell__body">
        <TerminalPane pane={pane} />
      </div>
    </div>
  );
}

function EmptySlot({ leafId, projectId }: { leafId: string; projectId: string }) {
  const t = useT();
  const close = () => useLayoutStore.getState().closeEmptySlot(leafId);
  return (
    <div className="empty-slot">
      <div className="empty-slot__header">
        <span className="empty-slot__title">{t('pane.emptySlotTitle')}</span>
        <button
          type="button"
          className="pane-cell__close"
          onClick={close}
          title={t('pane.emptySlotCancel')}
          aria-label={t('pane.emptySlotCancel')}
        >
          <IconClose size={12} />
        </button>
      </div>
      <div className="empty-slot__body">
        <AgentPicker projectId={projectId} />
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
