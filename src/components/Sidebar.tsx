/**
 * Sidebar —— 左侧「图标栏 + 内容页」。
 *
 * 结构：
 * - .sidebar__rail：图标栏，常驻显示，顶部为「项目」「集成」两个入口，
 *   底部常驻设置按钮（动作，不是可展开分区）；
 * - .sidebar__panel：内容页，选中图标时展开，取消选中（再点一次）收起。
 *
 * 启动默认选中「项目」并展开（状态由 uiStore.sidebarSection 维护，不持久化）。
 */

import type { ReactNode } from 'react';
import { useProjectGroups, useFocusedPaneId } from '../stores/sessionStore';
import { useUiStore, useSettingsOpen } from '../stores/uiStore';
import { useT } from '../i18n';
import { addProject, pickDirectory } from '../ipc/client';
import { ProjectGroup } from './ProjectGroup';
import { IntegrationsPanel } from './IntegrationsPanel';
import { IconPlus, IconFolder, IconIntegrations, IconSettings } from './icons';

export function Sidebar() {
  const t = useT();
  const groups = useProjectGroups();
  const focusedPaneId = useFocusedPaneId();
  const section = useUiStore((s) => s.sidebarSection);
  const toggleSection = useUiStore((s) => s.toggleSidebarSection);
  const settingsOpen = useSettingsOpen();
  const openSettings = useUiStore((s) => s.openSettings);

  const handleAddProject = async () => {
    const path = await pickDirectory(t('sidebar.addProject'));
    if (path) {
      addProject(path);
    }
  };

  return (
    <aside className={`sidebar ${section ? '' : 'sidebar--collapsed'}`}>
      {/* 图标栏：常驻，选中态有圆角底色块 */}
      <nav className="sidebar__rail">
        <RailButton
          icon={<IconFolder size={18} />}
          label={t('sidebar.projects')}
          active={section === 'projects'}
          onClick={() => toggleSection('projects')}
        />
        <RailButton
          icon={<IconIntegrations size={18} />}
          label={t('settings.integrations')}
          active={section === 'integrations'}
          onClick={() => toggleSection('integrations')}
        />

        {/* 设置：底部常驻动作按钮，打开设置弹窗，不参与侧栏分区切换 */}
        <button
          type="button"
          className={`sidebar__rail-button sidebar__rail-button--settings ${settingsOpen ? 'is-active' : ''}`}
          onClick={() => openSettings()}
          title={t('settings.title')}
          aria-label={t('settings.title')}
          aria-current={settingsOpen}
        >
          <IconSettings size={18} />
        </button>
      </nav>

      {section && (
        <div className="sidebar__panel">
          {section === 'projects' ? (
            <>
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
            </>
          ) : (
            <>
              <div className="sidebar__header">
                <span className="sidebar__title">{t('settings.integrations')}</span>
              </div>
              <IntegrationsPanel />
            </>
          )}
        </div>
      )}
    </aside>
  );
}

function RailButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`sidebar__rail-button ${active ? 'is-active' : ''}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-current={active}
    >
      {icon}
    </button>
  );
}
