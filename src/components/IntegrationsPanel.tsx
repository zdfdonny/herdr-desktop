/**
 * IntegrationsPanel —— 侧栏「集成」页的正文内容。
 *
 * 从设置弹窗里迁出：官方集成 hook 的安装状态列表 + 一键安装。
 * 侧栏宽度较窄，因此说明文案与「一键安装」按钮改为纵向堆叠，
 * 与设置弹窗里的横向排版不同。
 *
 * 列表与安装逻辑已抽到 IntegrationAgentList，与首次启动引导弹窗共用。
 */

import { useT } from '../i18n';
import { IntegrationAgentList } from './IntegrationAgentList';

export function IntegrationsPanel() {
  const t = useT();

  return (
    <div className="integrations-panel">
      <p className="integrations-intro">{t('settings.integrationsHint')}</p>
      <IntegrationAgentList />
    </div>
  );
}
