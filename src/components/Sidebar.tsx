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
import { useIntegrationUpdateCount } from '../stores/integrationsStore';
import { useT, usePlural } from '../i18n';
import { addProject, pickDirectory } from '../ipc/client';
import { ProjectGroup } from './ProjectGroup';
import { IntegrationsPanel } from './IntegrationsPanel';
import { IconPlus, IconFolder, IconIntegrations, IconSettings } from './icons';

export function Sidebar() {
  const t = useT();
  const plural = usePlural();
  const groups = useProjectGroups();
  const focusedPaneId = useFocusedPaneId();
  const section = useUiStore((s) => s.sidebarSection);
  const toggleSection = useUiStore((s) => s.toggleSidebarSection);
  const settingsOpen = useSettingsOpen();
  const openSettings = useUiStore((s) => s.openSettings);
  /** 待更新的集成数量（0 时不显示徽标）。 */
  const integrationUpdateCount = useIntegrationUpdateCount();

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
          // 有集成待更新时显示待更新数量，悬停提示说明含义；全部更新完成后自动消失
          badge={
            integrationUpdateCount > 0
              ? {
                  count: integrationUpdateCount,
                  label: plural('sidebar.integrationsUpdateBadge', integrationUpdateCount),
                }
              : undefined
          }
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
  badge,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  /** 待处理数量徽标；给定即显示数字（如集成待更新数量）。 */
  badge?: { count: number; label: string };
  onClick: () => void;
}) {
  /*
   * 徽标里的数字对读屏器是个孤立的数字，因此徽标本身隐藏（aria-hidden），
   * 把完整含义并进按钮的可访问名称，保证「有更新」不只靠颜色传达。
   */
  const title = badge ? `${label} · ${badge.label}` : label;
  return (
    <button
      type="button"
      className={`sidebar__rail-button ${active ? 'is-active' : ''}`}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-current={active}
    >
      {icon}
      {badge && (
        <span className="sidebar__rail-badge" aria-hidden="true">
          {badge.count}
        </span>
      )}
    </button>
  );
}
