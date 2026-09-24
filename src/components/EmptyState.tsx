/**
 * EmptyState —— 工作区初始状态（无选中 agent 时显示）。
 *
 * 无论「没有项目」还是「有项目但没选中 agent」，都显示同一套引导：
 * 图标 + 「添加一个项目开始使用」 + 「添加项目」按钮。
 * 不再区分两种状态——初始引导越简单越好，避免把新用户推向多个入口。
 */

import { addProject, pickDirectory } from '../ipc/client';
import { useT } from '../i18n';

export function EmptyState() {
  const t = useT();

  const handleAddProject = async () => {
    const path = await pickDirectory(t('sidebar.addProject'));
    if (path) {
      addProject(path);
    }
  };

  return (
    <div className="empty-state">
      <div className="empty-state__logo" aria-hidden="true">
        ⌘
      </div>
      <h1 className="empty-state__title">{t('empty.addProjectTitle')}</h1>
      <div className="empty-state__actions">
        <button type="button" className="button button--primary" onClick={handleAddProject}>
          {t('empty.addProject')}
        </button>
      </div>
    </div>
  );
}
