/**
 * ProjectGroup —— 侧栏中的一个项目分组（可折叠）。
 *
 * "Choose project" 模型：
 * 项目是 agent 的容器，显示项目名、路径、agent 计数与状态汇总。
 */

import { useEffect, useRef, useState } from 'react';
import type { ProjectGroup as ProjectGroupData } from '../stores/sessionStore';
import { useUiStore } from '../stores/uiStore';
import { AgentRow } from './AgentRow';
import { AgentPicker } from './AgentPicker';
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
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);

  /** 浮窗宽度，与 CSS .agent-picker-popover 保持一致。 */
  const PICKER_WIDTH = 232;

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

  /** 计算锚点并打开浮窗。 */
  const openPicker = () => {
    const rect = addButtonRef.current?.getBoundingClientRect();
    if (rect) {
      /*
       * 「+」按钮贴近侧栏右缘，浮窗若左对齐按钮会溢出窗口，
       * 因此改为右对齐按钮并夹在窗口内（至少留 8px 边距）。
       */
      const left = Math.max(
        8,
        Math.min(rect.right - PICKER_WIDTH, window.innerWidth - PICKER_WIDTH - 8),
      );
      setAnchor({ top: rect.bottom + 4, left });
    }
    setShowPicker(true);
  };

  const closePicker = () => setShowPicker(false);

  const togglePicker = () => {
    if (showPicker) {
      closePicker();
      return;
    }
    openPicker();
  };

  // 响应全局「新建 agent」请求（Ctrl+T 等入口）
  const openAgentPickerRequest = useUiStore((s) => s.openAgentPickerRequest);
  useEffect(() => {
    if (openAgentPickerRequest?.projectId !== project.projectId) return;
    openPicker();
    useUiStore.getState().clearOpenAgentPickerRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAgentPickerRequest, project.projectId]);

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
          style={{ top: anchor.top, left: anchor.left }}
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
