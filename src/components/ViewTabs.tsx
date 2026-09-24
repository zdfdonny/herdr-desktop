/**
 * ViewTabs —— 主区顶部的视图标签栏。
 *
 * 侧栏里新建 agent 会新开一个独立视图（而不是挤进当前分屏），
 * 多个视图并存时用这条标签栏切换；只有一个视图时整条隐藏。
 *
 * 标签文案取该视图内第一个 pane 的 label；视图内分屏时附带 pane 数量。
 * 关闭标签只收起视图（把它的 pane 从排列里摘掉），不杀掉进程——
 * 进程仍在侧栏列表里，点击即可重新打开。
 */

import { useSessionStore } from '../stores/sessionStore';
import { useLayoutStore, type View } from '../stores/layoutStore';
import { useT } from '../i18n';
import { IconClose } from './icons';

interface ViewTabsProps {
  views: View[];
  activeViewId: string | null;
}

export function ViewTabs({ views, activeViewId }: ViewTabsProps) {
  const t = useT();
  const panes = useSessionStore((s) => s.state.panes);
  const byId = new Map(panes.map((p) => [p.paneId, p]));

  return (
    <div className="view-tabs" role="tablist">
      {views.map((view) => {
        const paneIds = collectPaneIds(view);
        const first = paneIds.map((id) => byId.get(id)).find(Boolean);
        const label = first?.label ?? first?.paneId ?? t('view.empty');
        const active = view.id === activeViewId;
        return (
          <div
            key={view.id}
            className={`view-tab ${active ? 'is-active' : ''}`}
            role="tab"
            aria-selected={active}
          >
            <button
              type="button"
              className="view-tab__label"
              onClick={() => useLayoutStore.getState().activateView(view.id)}
              title={label}
            >
              <span className="view-tab__text">{label}</span>
              {paneIds.length > 1 && (
                <span className="view-tab__count">{paneIds.length}</span>
              )}
            </button>
            <button
              type="button"
              className="view-tab__close"
              onClick={(e) => {
                e.stopPropagation();
                useLayoutStore.getState().closeView(view.id);
              }}
              title={t('view.close')}
              aria-label={t('view.close')}
            >
              <IconClose size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** 取视图树里的 pane id（顺序即视觉顺序）。 */
function collectPaneIds(view: View): string[] {
  const out: string[] = [];
  const scan = (node: View['tree']): void => {
    if (!node) return;
    if (node.type === 'pane') {
      out.push(node.paneId);
      return;
    }
    if (node.type === 'split') {
      scan(node.children[0]);
      scan(node.children[1]);
    }
  };
  scan(view.tree);
  return out;
}
