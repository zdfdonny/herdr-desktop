/**
 * IntegrationsOnboardingDialog —— 首次启动的集成功能引导弹窗。
 *
 * 与确认弹窗同风格：遮罩 + 居中卡片。文案来自 i18n（onboarding.*）。
 * 除了说明「集成是什么」，还内嵌可操作的集成列表（安装 / 卸载 / 一键安装），
 * 并告诉用户下次在哪里找到它（左侧栏的「集成」图标）。
 *
 * 布局：顶部（图标+标题、说明、一键安装）与底部（位置提示、知道了按钮）固定，
 * 只有中间的智能体列表滚动，小窗口下也不怕内容溢出。
 *
 * 展示时机由 App.tsx 在首次启动时根据 settings.integrationsOnboarded 决定，
 * 关闭后由 App.tsx 负责把该标记持久化为 true，保证只引导一次。
 */

import { useUiStore } from '../stores/uiStore';
import { useT } from '../i18n';
import { IconIntegrations } from './icons';
import { Modal } from './Modal';
import {
  useIntegrationHooks,
  IntegrationInstallAllButton,
  IntegrationStatusList,
} from './IntegrationAgentList';

export function IntegrationsOnboardingDialog() {
  const t = useT();
  const open = useUiStore((s) => s.integrationsOnboardingOpen);
  const close = useUiStore((s) => s.closeIntegrationsOnboarding);
  // 弹窗常驻挂载，只在打开时才拉取 hook 安装状态
  const hooks = useIntegrationHooks(open);

  if (!open) return null;

  return (
    <Modal
      overlayClassName="onboarding-overlay"
      dialogClassName="onboarding-dialog"
      ariaLabel={t('onboarding.integrationsTitle')}
      onOverlayMouseDown={close}
      onClose={close}
    >
      {/* 顶部：图标 + 标题同行 */}
      <div className="onboarding-dialog__header">
        <span className="onboarding-dialog__icon" aria-hidden="true">
          <IconIntegrations size={20} />
        </span>
        <h2 id="onboarding-title" className="onboarding-dialog__title">
          {t('onboarding.integrationsTitle')}
        </h2>
      </div>

      <p className="onboarding-dialog__body">{t('onboarding.integrationsBody')}</p>

      {/* 一键安装固定在顶部，不随列表滚动 */}
      <div className="onboarding-dialog__install-all">
        <IntegrationInstallAllButton
          statuses={hooks.hookStatuses}
          busyAll={hooks.hookBusyAll}
          onInstallAll={hooks.handleInstallAll}
        />
      </div>

      {/* 只有智能体列表滚动 */}
      <div className="onboarding-dialog__agent-list">
        <IntegrationStatusList
          statuses={hooks.hookStatuses}
          busy={hooks.hookBusy}
          onInstall={hooks.handleHookInstall}
          onUninstall={hooks.handleHookUninstall}
        />
      </div>

      {/* 位置提示：视觉上复刻侧栏「集成」按钮，方便用户按图索骥 */}
      <div className="onboarding-dialog__where">
        <span className="onboarding-dialog__rail-icon" aria-hidden="true">
          <IconIntegrations size={16} />
        </span>
        <div className="onboarding-dialog__where-text">
          <span className="onboarding-dialog__where-title">
            {t('onboarding.integrationsWhereTitle')}
          </span>
          <span className="onboarding-dialog__where-detail">
            {t('onboarding.integrationsWhereDetail')}
          </span>
        </div>
      </div>

      <div className="onboarding-dialog__actions">
        <button type="button" className="button button--primary" onClick={close} autoFocus>
          {t('onboarding.integrationsGotIt')}
        </button>
      </div>
    </Modal>
  );
}
