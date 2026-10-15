/**
 * IntegrationAgentList —— 官方集成 hook 的安装状态列表 + 一键安装。
 *
 * 侧栏「集成」页与首次启动的集成引导弹窗共用。
 * 为支持弹窗「上下固定、只有列表滚动」的布局，这里拆成：
 * - useIntegrationHooks：共享的状态与安装/卸载动作（读 integrationsStore）；
 * - IntegrationInstallAllButton：一键安装按钮；
 * - IntegrationStatusList：智能体状态列表；
 * - IntegrationAgentList：按钮 + 列表的组合（侧栏集成页使用）。
 *
 * 状态权威来自 Main（getHookStatuses / installHook / uninstallHook），
 * 但状态本身存放在 integrationsStore：侧栏「集成」按钮上的待更新数量徽标
 * 要在集成页未打开时就可见，因此不能留在组件内部。
 */

import { useEffect, type ReactNode } from 'react';
import type { HookStatus } from '@shared/protocol';
import { AGENT_PRESETS, useAgentsStore, isAvailable } from '../stores/agentsStore';
import { useIntegrationsStore } from '../stores/integrationsStore';
import { useT } from '../i18n';

export interface IntegrationHooks {
  hookStatuses: Record<string, HookStatus>;
  hookBusy: string[];
  hookBusyAll: boolean;
  handleHookInstall: (agentId: string) => void;
  handleHookUninstall: (agentId: string) => void;
  handleInstallAll: () => void;
}

/**
 * 共享的集成 hook 状态与动作（integrationsStore 的读取适配层）。
 *
 * @param enabled 是否在挂载时刷新安装状态。App 启动时已拉取过一次
 *                （侧栏「集成」按钮上的待更新数量徽标依赖它），这里再拉一次
 *                只为保证打开面板/弹窗时看到的是最新状态。
 */
export function useIntegrationHooks(enabled = true): IntegrationHooks {
  const hookStatuses = useIntegrationsStore((s) => s.hookStatuses);
  const hookBusy = useIntegrationsStore((s) => s.busy);
  const hookBusyAll = useIntegrationsStore((s) => s.busyAll);
  const refresh = useIntegrationsStore((s) => s.refresh);
  const install = useIntegrationsStore((s) => s.install);
  const uninstall = useIntegrationsStore((s) => s.uninstall);
  const installAll = useIntegrationsStore((s) => s.installAll);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  return {
    hookStatuses,
    hookBusy,
    hookBusyAll,
    handleHookInstall: (agentId) => void install(agentId),
    handleHookUninstall: (agentId) => void uninstall(agentId),
    handleInstallAll: () => void installAll(),
  };
}

export function IntegrationInstallAllButton({
  statuses,
  busyAll,
  onInstallAll,
}: {
  statuses: Record<string, HookStatus>;
  busyAll: boolean;
  onInstallAll: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className="button integrations-install-all"
      onClick={onInstallAll}
      disabled={busyAll || Object.keys(statuses).length === 0}
    >
      {busyAll ? '…' : t('settings.installAllHooks')}
    </button>
  );
}

export function IntegrationStatusList({
  statuses,
  busy,
  onInstall,
  onUninstall,
}: {
  statuses: Record<string, HookStatus>;
  busy: string[];
  onInstall: (agentId: string) => void;
  onUninstall: (agentId: string) => void;
}) {
  const t = useT();
  const availability = useAgentsStore((s) => s.availability);
  const probed = useAgentsStore((s) => s.probed);

  return (
    <ul className="agent-status-list">
      {AGENT_PRESETS.map((preset) => {
        const isOk = isAvailable(availability, probed, preset.command);
        const hookStatus = statuses[preset.id];
        const isBusy = busy.includes(preset.id);

        /*
         * 状态列的五种情况：
         * - 未安装 → 未找到
         * - 已安装但不支持集成（不在 HOOK_TARGETS）→ 不支持
         * - 已安装未集成 → 安装
         * - 已集成 → 卸载
         * - 已集成但版本旧 → 更新
         */
        let statusCell: ReactNode;
        if (!isOk) {
          statusCell = (
            <span className="agent-status__state-text">
              {t('settings.integrationNotFound')}
            </span>
          );
        } else if (hookStatus === undefined || hookStatus === 'unsupported') {
          statusCell = (
            <span className="agent-status__state-text">
              {t('settings.integrationUnsupported')}
            </span>
          );
        } else if (hookStatus === 'installed') {
          statusCell = (
            <button
              type="button"
              className="button button--small"
              disabled={isBusy}
              onClick={() => onUninstall(preset.id)}
            >
              {isBusy ? '…' : t('settings.uninstallHook')}
            </button>
          );
        } else if (hookStatus === 'outdated') {
          statusCell = (
            <button
              type="button"
              className="button button--small"
              disabled={isBusy}
              onClick={() => onInstall(preset.id)}
            >
              {isBusy ? '…' : t('settings.integrationUpdate')}
            </button>
          );
        } else {
          statusCell = (
            <button
              type="button"
              className="button button--small"
              disabled={isBusy}
              onClick={() => onInstall(preset.id)}
            >
              {isBusy ? '…' : t('settings.installHook')}
            </button>
          );
        }

        return (
          <li key={preset.id} className="agent-status">
            <span className="agent-status__agent">
              <span
                className={`agent-status__dot ${isOk ? 'is-ok' : 'is-missing'}`}
                aria-hidden="true"
              />
              <span className="agent-status__name">{preset.label}</span>
            </span>
            <span className="agent-status__state">{statusCell}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** 按钮 + 列表的组合：侧栏「集成」页使用。 */
export function IntegrationAgentList() {
  const hooks = useIntegrationHooks();
  return (
    <>
      <IntegrationInstallAllButton
        statuses={hooks.hookStatuses}
        busyAll={hooks.hookBusyAll}
        onInstallAll={hooks.handleInstallAll}
      />
      <IntegrationStatusList
        statuses={hooks.hookStatuses}
        busy={hooks.hookBusy}
        onInstall={hooks.handleHookInstall}
        onUninstall={hooks.handleHookUninstall}
      />
    </>
  );
}
