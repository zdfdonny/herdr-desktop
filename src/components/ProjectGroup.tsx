/**
 * ProjectGroup —— 侧栏中的一个项目分组（可折叠）。
 *
 * "Choose project" 模型：
 * 项目是 agent 的容器，显示项目名、路径、agent 计数与状态汇总。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProjectGroup as ProjectGroupData } from '../stores/sessionStore';
import { useUiStore } from '../stores/uiStore';
import { AgentRow } from './AgentRow';
import { AgentPicker } from './AgentPicker';
import { computePickerAnchor } from './agent-picker-position';
import type { PickerAnchor } from './agent-picker-position';
import { toggleProject, removeProject } from '../ipc/client';
import { useT } from '../i18n';
import { IconChevronDown, IconPlus, IconClose } from './icons';

interface ProjectGroupProps {
  group: ProjectGroupData;
  focusedPaneId: string | null;
}

export function ProjectGroup({ group, focusedPaneId }: ProjectGroupProps) {
  const t = useT();
  const { project, agents, blockedCount, workingCount } = group;
  const [showPicker, setShowPicker] = useState(false);
  /** 「+」按钮，用于定位浮窗。 */
  const addButtonRef = useRef<HTMLButtonElement>(null);
  /** 浮窗容器，用于判断点击是否落在浮窗内。 */
  const pickerRef = useRef<HTMLDivElement>(null);
  /** 浮窗锚点坐标（fixed 定位，脱离侧栏 overflow 裁剪）。 */
  const [anchor, setAnchor] = useState<PickerAnchor | null>(null);
  /** 本次打开是否已按实测内容高度复算过锚点（避免测量-重排循环）。 */
  const measuredRef = useRef(false);

  /*
   * 浮窗打开时：点击浮窗外部任意位置、按 Esc、或滚动/改变窗口大小都关闭。
   * 用 mousedown 而非 click，避免拖拽选中文本时误关。
   */
  useEffect(() => {
    if (!showPicker) return;

    const close = () => setShowPicker(false);

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (addButtonRef.current?.contains(target)) return;
      if (pickerRef.current?.contains(target)) return;
      close();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };

    /*
     * 浮窗自身可滚动（max-height + overflow-y），因此滚动事件需区分来源：
     * 捕获阶段监听能拿到任意滚动容器的事件，但落在浮窗内的一律忽略，
     * 否则滚动列表会立刻把浮窗关掉。
     */
    const onScroll = (e: Event) => {
      if (pickerRef.current?.contains(e.target as Node)) return;
      close();
    };

    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [showPicker]);

  /** 按「+」按钮当前位置计算锚点；contentHeight 为实测内容高度（首帧省略）。 */
  const anchorFromButton = (contentHeight?: number): PickerAnchor | null => {
    const button = addButtonRef.current;
    const rect = button?.getBoundingClientRect();
    if (!button || !rect) return null;
    /*
     * 弹出框水平居中于侧栏内容页（.sidebar__panel），而不是贴靠「+」按钮。
     * 垂直方向与最大高度交给 computePickerAnchor：项目多时「+」按钮会贴近
     * 窗口底部，固定向下弹出会让浮窗下半部分落到可视区外。
     */
    const panel = button.closest('.sidebar__panel');
    const panelRect = panel instanceof HTMLElement ? panel.getBoundingClientRect() : null;
    return computePickerAnchor({
      button: { top: rect.top, bottom: rect.bottom, right: rect.right },
      panel: panelRect ? { left: panelRect.left, width: panelRect.width } : null,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      contentHeight,
    });
  };

  /** 计算锚点并打开浮窗。 */
  const openPicker = () => {
    measuredRef.current = false;
    // 拿不到按钮位置时不渲染浮窗（避免沿用上一次的坐标）。
    setAnchor(anchorFromButton());
    setShowPicker(true);
  };

  /*
   * 首帧只能按假定高度定位，而列表高度取决于本机已安装的智能体数量。
   * 浮窗挂载后立刻用实测内容高度复算一次：只有这样才能判断「下方放不下、
   * 上方更宽裕」从而正确向上翻转。useLayoutEffect 在浏览器绘制前完成，
   * 用户看不到先向下再翻转的跳动。
   */
  useLayoutEffect(() => {
    if (!showPicker || measuredRef.current) return;
    const popover = pickerRef.current;
    if (!popover) return;
    // scrollHeight 是内容自然高度，不受 max-height 夹取影响。
    const contentHeight = popover.scrollHeight;
    if (contentHeight <= 0) return;
    measuredRef.current = true;
    setAnchor(anchorFromButton(contentHeight));
    // anchorFromButton 只依赖 ref 与窗口尺寸，无需列入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPicker]);

  const closePicker = () => setShowPicker(false);

  const togglePicker = () => {
    if (showPicker) {
      closePicker();
      return;
    }
    openPicker();
  };

  const handleToggle = () => {
    toggleProject(project.projectId, !project.collapsed);
  };

  const handleRemove = () => {
    useUiStore.getState().openConfirm({
      title: t('sidebar.removeProject'),
      message: t('sidebar.removeProjectConfirm', { name: project.name }),
      onConfirm: () => removeProject(project.projectId),
    });
  };

  return (
    <div className="project-group">
      <div className="project-group__header" onClick={handleToggle}>
        <span
          className={`project-group__chevron ${project.collapsed ? 'is-collapsed' : ''}`}
          title={project.collapsed ? t('sidebar.expandProject') : t('sidebar.collapseProject')}
        >
          <IconChevronDown size={14} />
        </span>
        <div className="project-group__info">
          <div className="project-group__name-row">
            <span className="project-group__name" title={project.path}>
              {project.name}
            </span>
            {project.branch && (
              <span className="project-group__branch" title={project.branch}>
                {project.branch}
              </span>
            )}
          </div>
          <span className="project-group__path">{project.path}</span>
        </div>

        <div className="project-group__badges">
          {blockedCount > 0 && (
            <span className="project-group__badge project-group__badge--blocked">
              {blockedCount}
            </span>
          )}
          {workingCount > 0 && (
            <span className="project-group__badge project-group__badge--working">
              {workingCount}
            </span>
          )}
        </div>

        <div className="project-group__actions">
          <button
            type="button"
            ref={addButtonRef}
            className="icon-button"
            onClick={(e) => {
              e.stopPropagation();
              togglePicker();
            }}
            title={t('sidebar.newAgent')}
            aria-label={t('sidebar.newAgent')}
            aria-expanded={showPicker}
          >
            <IconPlus size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={(e) => {
              e.stopPropagation();
              handleRemove();
            }}
            title={t('sidebar.removeProject')}
            aria-label={t('sidebar.removeProject')}
          >
            <IconClose size={14} />
          </button>
        </div>
      </div>

      {showPicker && anchor && (
        <div
          ref={pickerRef}
          className="agent-picker-popover"
          style={{
            top: anchor.top,
            bottom: anchor.bottom,
            left: anchor.left,
            maxHeight: anchor.maxHeight,
          }}
        >
          <AgentPicker projectId={project.projectId} onPick={() => setShowPicker(false)} />
        </div>
      )}

      {!project.collapsed && (
        <div className="project-group__agents">
          {agents.map((agent) => (
            <AgentRow
              key={agent.paneId}
              agent={agent}
              focused={agent.paneId === focusedPaneId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
