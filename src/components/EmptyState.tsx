/**
 * EmptyState —— 工作区初始状态（无选中 agent 时显示）。
 *
 * 两种状态共用同一套简单布局：图标 + 标题 + 「添加项目」按钮。
 * - 无项目：引导添加第一个项目（目录选择器）。
 * - 有项目但未选中 agent：提示从左侧列表选择，同样提供添加入口。
 */

import { useProjectGroups } from '../stores/sessionStore';
import { addProject, pickDirectory } from '../ipc/client';
import { useT } from '../i18n';

export function EmptyState() {
  const t = useT();
  const groups = useProjectGroups();

  const handleAddProject = async () => {
    const path = await pickDirectory(t('sidebar.addProject'));
    if (path) {
      addProject(path);
    }
  };

  const title = groups.length === 0 ? t('empty.addProjectTitle') : t('empty.selectAgentTitle');

  return (
    <div className="empty-state">
      <div className="empty-state__logo" aria-hidden="true">
        ⌘
      </div>
      <h1 className="empty-state__title">{title}</h1>
      <div className="empty-state__actions">
        <button type="button" className="button button--primary" onClick={handleAddProject}>
          {t('empty.addProject')}
        </button>
      </div>
    </div>
  );
}
