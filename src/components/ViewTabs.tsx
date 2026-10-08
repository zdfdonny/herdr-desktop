/**
 * ViewTabs —— 主区顶部的视图标签栏。
 *
 * 侧栏里新建 agent 会新开一个独立视图（而不是挤进当前分屏），
 * 多个视图并存时用这条标签栏切换；只有一个视图时整条隐藏。
 *
 * 标签默认名是固定的 "New tab"，不跟随内部 agent 变化；
 * 分屏后视图里有多个 agent，用第一个的名字会误导。
 * 右键标签（或快捷键 F2）可就地重命名，清空则恢复默认名。
 *
 * 关闭标签会**连同标签里的智能体一起关闭**（杀进程、移除会话条目）。
 */

import { useEffect, useRef, useState } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useLayoutStore, MAX_VIEW_NAME_LENGTH, viewPaneIds, type View } from '../stores/layoutStore';
import { useUiStore } from '../stores/uiStore';
import { useT } from '../i18n';
import { IconClose } from './icons';
import { activateViewTab, closeViewTab } from './viewActivation';

interface ViewTabsProps {
  views: View[];
  activeViewId: string | null;
}

export function ViewTabs({ views, activeViewId }: ViewTabsProps) {
  const t = useT();
  const panes = useSessionStore((s) => s.state.panes);
  const byId = new Map(panes.map((p) => [p.paneId, p]));
  /*
   * 正在重命名的标签 id 放在 uiStore 而非本地 state：
   * 快捷键 F2 需要从组件外触发重命名，本地 state 无法被外部访问。
   */
  const renamingViewId = useUiStore((s) => s.renamingViewId);
  const startRenameView = useUiStore((s) => s.startRenameView);
  const stopRenameView = useUiStore((s) => s.stopRenameView);

  return (
    <div className="view-tabs" role="tablist">
      {views.map((view) => {
        const paneIds = viewPaneIds(view);
        const active = view.id === activeViewId;
        return (
          <div
            key={view.id}
            className={`view-tab ${active ? 'is-active' : ''}`}
            role="tab"
            aria-selected={active}
            /*
             * 右键进入重命名。用右键而不是双击：双击与「点击激活」的
             * 两次 click 难以区分，会让切换标签变得不跟手。
             */
            onContextMenu={(e) => {
              e.preventDefault();
              startRenameView(view.id);
            }}
          >
            {renamingViewId === view.id ? (
              <ViewTabRename
                initial={view.name}
                onDone={stopRenameView}
                onCommit={(name) => {
                  useLayoutStore.getState().renameView(view.id, name);
                  stopRenameView();
                }}
              />
            ) : (
              <>
                <button
                  type="button"
                  className="view-tab__label"
                  onClick={() => activateViewTab(view)}
                  title={paneTitle(view, paneIds, byId, t('view.renameHint'))}
                >
                  <span className="view-tab__text">{view.name}</span>
                  {paneIds.length > 1 && (
                    <span className="view-tab__count">{paneIds.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  className="view-tab__close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeViewTab(view);
                  }}
                  title={t('view.close')}
                  aria-label={t('view.close')}
                >
                  <IconClose size={14} />
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 标签名的 hover 提示：显示视图内第一个 agent 的名字。
 *
 * 标签本身只显示序号，agent 名放到 tooltip 里，
 * 既不丢信息也不会让标签宽度随 agent 名跳动。
 */
function paneTitle(
  view: View,
  paneIds: string[],
  byId: Map<string, { label: string | null; paneId: string }>,
  hint: string,
): string {
  const first = paneIds.map((id) => byId.get(id)).find(Boolean);
  const agentName = first?.label ?? first?.paneId ?? view.name;
  return `${agentName}\n${hint}`;
}

/** 就地重命名输入框：回车提交，Esc 或失焦取消。 */
function ViewTabRename({
  initial,
  onCommit,
  onDone,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  /*
   * Esc 取消后，卸载输入框会立刻触发 onBlur——若不拦住，
   * 那次 blur 会把刚被放弃的值提交上去，Esc 就形同虚设。
   * 用 ref 而不是 state：blur 与 keydown 在同一个事件循环里，
   * setState 的异步更新来不及在 blur 前生效。
   */
  const cancelled = useRef(false);

  // 挂载后聚焦并全选，省掉用户手动清空
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className="view-tab__rename"
      value={value}
      maxLength={MAX_VIEW_NAME_LENGTH}
      onChange={(e) => setValue(e.target.value)}
      // 输入框在标签内部，点击不应触发标签的激活逻辑
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          cancelled.current = true;
          onCommit(value);
        } else if (e.key === 'Escape') {
          cancelled.current = true;
          onDone();
        }
      }}
      // 失焦即提交，符合「点开就改」的直觉
      onBlur={() => {
        if (cancelled.current) return;
        onCommit(value);
      }}
      aria-label={initial}
    />
  );
}
