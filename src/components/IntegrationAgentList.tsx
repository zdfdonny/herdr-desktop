/**
 * IntegrationAgentList —— 官方集成 hook 的安装状态列表 + 一键安装。
 *
 * 侧栏「集成」页与首次启动的集成引导弹窗共用。
 * 为支持弹窗「上下固定、只有列表滚动」的布局，这里拆成：
 * - useIntegrationHooks：共享的状态与安装/卸载动作；
 * - IntegrationInstallAllButton：一键安装按钮；
 * - IntegrationStatusList：智能体状态列表；
 * - IntegrationAgentList：按钮 + 列表的组合（侧栏集成页使用）。
 *
 * 状态权威来自 Main（getHookStatuses / installHook / uninstallHook）。
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { HookStatus } from '@shared/protocol';
import { AGENT_PRESETS, useAgentsStore, isAvailable } from '../stores/agentsStore';
import { getHookStatuses, installHook, uninstallHook } from '../ipc/client';
import { useNotificationStore } from '../stores/notificationStore';
import { useT } from '../i18n';

export interface IntegrationHooks {
  hookStatuses: Record<string, HookStatus>;
  hookBusy: string | null;
  hookBusyAll: boolean;
  handleHookInstall: (agentId: string) => void;
  handleHookUninstall: (agentId: string) => void;
  handleInstallAll: () => void;
}

/**
 * 共享的集成 hook 状态与动作。
 *
 * @param enabled 是否拉取安装状态。首次启动引导弹窗常驻挂载，
 *                但只有弹窗打开时才需要拉取，避免每次启动都多一次 IPC。
 */
export function useIntegrationHooks(enabled = true): IntegrationHooks {
  const availability = useAgentsStore((s) => s.availability);
  const probed = useAgentsStore((s) => s.probed);
  /** 官方集成 hook 安装状态：agentId → installed/not-installed/unsupported。 */
  const [hookStatuses, setHookStatuses] = useState<Record<string, HookStatus>>({});
  const [hookBusy, setHookBusy] = useState<string | null>(null);
  const [hookBusyAll, setHookBusyAll] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    void getHookStatuses()
      .then(setHookStatuses)
      .catch(() => setHookStatuses({}));
  }, [enabled]);

  const notifyInstallError = (agentId: string, error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    useNotificationStore.getState().push({
      kind: 'error',
      titleKey: 'settings.integrationInstallFailed',
      titleVars: { agent: agentId },
      detailKey: 'settings.integrationInstallFailedDetail',
      detailVars: { error: message },
    });
  };

  const handleHookInstall = (agentId: string) => {
    setHookBusy(agentId);
    void installHook(agentId)
      .then((status) => setHookStatuses((prev) => ({ ...prev, [agentId]: status })))
      .catch((error) => notifyInstallError(agentId, error))
      .finally(() => setHookBusy(null));
  };

  const handleHookUninstall = (agentId: string) => {
    setHookBusy(agentId);
    void uninstallHook(agentId)
      .then((status) => setHookStatuses((prev) => ({ ...prev, [agentId]: status })))
      .catch((error) => notifyInstallError(agentId, error))
      .finally(() => setHookBusy(null));
  };

  const handleInstallAll = () => {
    setHookBusyAll(true);
    // 只给「本机已安装」的智能体装 hook/插件，未安装的不碰
    const agents = Object.keys(hookStatuses).filter((agentId) => {
      const preset = AGENT_PRESETS.find((p) => p.id === agentId);
      return preset ? isAvailable(availability, probed, preset.command) : false;
    });
    void Promise.all(
      agents.map((agentId) => installHook(agentId).catch(() => 'not-installed' as HookStatus)),
    )
      // 装完后从 Main 重新拉一次权威状态，确保 UI 反映真实落盘结果
      .then(() => getHookStatuses())
      .then((statuses) => setHookStatuses(statuses))
      .catch(() => undefined)
      .finally(() => setHookBusyAll(false));
  };

  return {
    hookStatuses,
    hookBusy,
    hookBusyAll,
    handleHookInstall,
    handleHookUninstall,
    handleInstallAll,
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
  busy: string | null;
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
        const isBusy = busy === preset.id;

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
