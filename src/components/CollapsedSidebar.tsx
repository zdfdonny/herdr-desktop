/**
 * CollapsedSidebar —— 收起态的图标栏。
 *
 * 约 48px 宽，只保留：
 * - 中部：每个项目一个首字母徽标 + agent 数状态点
 * - 底部：设置入口
 *
 * 展开按钮**不在这里**：它常驻 TitleBar，收起/展开两态位置不变，
 * 避免按钮在两种状态下跳到不同位置。
 */

import type { ProjectGroup as ProjectGroupData } from '../stores/sessionStore';
import { useT } from '../i18n';
import { IconSettings } from './icons';

interface CollapsedSidebarProps {
  groups: ProjectGroupData[];
  focusedPaneId: string | null;
  onSelectProject: (projectId: string) => void;
  onQuickSpawn: (projectId: string) => void;
  settingsActive: boolean;
  onOpenSettings: () => void;
}

/** 取项目名首字符作为徽标（中文取首字，英文取首字母）。 */
function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

export function CollapsedSidebar({
  groups,
  focusedPaneId,
  onSelectProject,
  onQuickSpawn,
  settingsActive,
  onOpenSettings,
}: CollapsedSidebarProps) {
  const t = useT();

  return (
    <aside className="sidebar sidebar--collapsed">
      <div className="sidebar__rail-list">
        {groups.map((group) => {
          const { project, agents, blockedCount, workingCount } = group;
          const hasFocused = agents.some((a) => a.paneId === focusedPaneId);
          const statusClass = blockedCount
            ? 'is-blocked'
            : workingCount
              ? 'is-working'
              : 'is-idle';
          return (
            <button
              key={project.projectId}
              type="button"
              className={`rail-project ${hasFocused ? 'is-active' : ''}`}
              onClick={() => onSelectProject(project.projectId)}
              onDoubleClick={() => onQuickSpawn(project.projectId)}
              title={`${project.name}\n${project.path}`}
              aria-label={project.name}
            >
              <span className="rail-project__badge">{initial(project.name)}</span>
              <span className={`rail-project__dot status-dot ${statusClass}`} />
            </button>
          );
        })}
      </div>

      <div className="sidebar__rail-footer">
        <button
          type="button"
          className={`icon-button sidebar__rail-button ${settingsActive ? 'is-active' : ''}`}
          onClick={onOpenSettings}
          title={t('settings.title')}
          aria-label={t('settings.title')}
        >
          <IconSettings size={16} />
        </button>
      </div>
    </aside>
  );
}