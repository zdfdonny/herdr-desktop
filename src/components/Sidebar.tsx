/**
 * Sidebar —— 左侧项目/agent 列表。
 *
 * 支持收起为窄图标栏（VSCode 活动栏风格）：
 * - 展开：完整项目分组 + agent 列表
 * - 收起：约 48px 宽，显示项目首字母 + 状态点，悬停有 tooltip
 *
 * 收起/展开按钮位于「项目」标题行，紧挨在新建项目加号右侧。
 * 左下角为设置入口（常驻，不随滚动）。
 */

import { useProjectGroups, useFocusedPaneId } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUiStore, useSettingsOpen } from '../stores/uiStore';
import { useT } from '../i18n';
import { AGENT_PRESETS, useAgentsStore, isAvailable } from '../stores/agentsStore';
import { addProject, pickDirectory, spawnAgent } from '../ipc/client';
import { ProjectGroup } from './ProjectGroup';
import { CollapsedSidebar } from './CollapsedSidebar';
import { IconPlus, IconSettings, IconLogo, IconPanelLeft } from './icons';

export function Sidebar() {
  const t = useT();
  const groups = useProjectGroups();
  const focusedPaneId = useFocusedPaneId();
  const collapsed = useSettingsStore((s) => s.settings.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore((s) => s.setSidebarCollapsed);
  const settingsOpen = useSettingsOpen();
  const openSettings = useUiStore((s) => s.openSettings);

  const handleAddProject = async () => {
    const path = await pickDirectory(t('sidebar.addProject'));
    if (path) {
      addProject(path);
    }
  };

  /** 收起态：点击项目直接在其下创建默认 agent 并展开侧栏。 */
  const handleQuickSpawn = (projectId: string) => {
    const availability = useAgentsStore.getState().availability;
    const probed = useAgentsStore.getState().probed;
    const preferred =
      AGENT_PRESETS.find(
        (p) => p.id !== 'terminal' && isAvailable(availability, probed, p.command),
      ) ?? AGENT_PRESETS.find((p) => p.id === 'terminal');
    if (preferred) {
      spawnAgent(projectId, preferred.command, { label: preferred.label });
      setSidebarCollapsed(false);
    }
  };

  if (collapsed) {
    return (
      <CollapsedSidebar
        groups={groups}
        focusedPaneId={focusedPaneId}
        onExpand={() => setSidebarCollapsed(false)}
        onSelectProject={() => setSidebarCollapsed(false)}
        onQuickSpawn={handleQuickSpawn}
        settingsActive={settingsOpen}
        onOpenSettings={openSettings}
      />
    );
  }

  return (
    <aside className="sidebar">
      {/* 品牌区：左侧 herdr 官方 logo，右侧应用名（无副标题） */}
      <div className="sidebar__brand">
        <span className="sidebar__brand-mark" aria-hidden="true">
          <IconLogo size={18} />
        </span>
        <div className="sidebar__brand-text">
          <span className="sidebar__brand-name">{t('app.name')}</span>
        </div>
      </div>

      <div className="sidebar__header">
        <span className="sidebar__title">{t('sidebar.projects')}</span>
        <div className="sidebar__header-actions">
          <button
            type="button"
            className="icon-button"
            onClick={handleAddProject}
            title={t('sidebar.addProject')}
            aria-label={t('sidebar.addProject')}
          >
            <IconPlus size={15} />
          </button>
          {/* 收起按钮：紧挨在新建项目加号右侧 */}
          <button
            type="button"
            className="icon-button"
            onClick={() => setSidebarCollapsed(true)}
            title={t('sidebar.collapse')}
            aria-label={t('sidebar.collapse')}
          >
            <IconPanelLeft size={15} />
          </button>
        </div>
      </div>

      <div className="sidebar__list">
        {groups.map((group) => (
          <ProjectGroup
            key={group.project.projectId}
            group={group}
            focusedPaneId={focusedPaneId}
          />
        ))}
      </div>

      <button
        type="button"
        className={`sidebar__settings ${settingsOpen ? 'is-active' : ''}`}
        onClick={openSettings}
        aria-current={settingsOpen}
      >
        <span className="sidebar__settings-icon" aria-hidden="true">
          <IconSettings size={16} />
        </span>
        <span className="sidebar__settings-label">{t('settings.title')}</span>
      </button>
    </aside>
  );
}
