/**
 * IntegrationsPanel —— 侧栏「集成」页的正文内容。
 *
 * 从设置弹窗里迁出：官方集成 hook 的安装状态列表 + 一键安装。
 * 侧栏宽度较窄，因此说明文案与「一键安装」按钮改为纵向堆叠，
 * 与设置弹窗里的横向排版不同。
 */

import { useEffect, useState } from 'react';
import type { HookStatus } from '@shared/protocol';
import { AGENT_PRESETS, useAgentsStore, isAvailable } from '../stores/agentsStore';
import { getHookStatuses, installHook, uninstallHook } from '../ipc/client';
import { useNotificationStore } from '../stores/notificationStore';
import { useT } from '../i18n';

export function IntegrationsPanel() {
  const t = useT();
  const availability = useAgentsStore((s) => s.availability);
  const probed = useAgentsStore((s) => s.probed);
  /** 官方集成 hook 安装状态：agentId → installed/not-installed/unsupported。 */
  const [hookStatuses, setHookStatuses] = useState<Record<string, HookStatus>>({});
  const [hookBusy, setHookBusy] = useState<string | null>(null);
  const [hookBusyAll, setHookBusyAll] = useState(false);

  // 加载 hook 安装状态
  useEffect(() => {
    void getHookStatuses()
      .then(setHookStatuses)
      .catch(() => setHookStatuses({}));
  }, []);

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

  return (
    <div className="integrations-panel">
      <p className="integrations-intro">{t('settings.integrationsHint')}</p>
      <button
        type="button"
        className="button integrations-install-all"
        onClick={handleInstallAll}
        disabled={hookBusyAll || Object.keys(hookStatuses).length === 0}
      >
        {hookBusyAll ? '…' : t('settings.installAllHooks')}
      </button>

      <ul className="agent-status-list">
        {AGENT_PRESETS.map((preset) => {
          const isOk = isAvailable(availability, probed, preset.command);
          const hookStatus = hookStatuses[preset.id];
          const busy = hookBusy === preset.id;

          /*
           * 状态列的五种情况：
           * - 未安装 → 未找到
           * - 已安装但不支持集成（不在 HOOK_TARGETS）→ 不支持
           * - 已安装未集成 → 安装
           * - 已集成 → 卸载
           * - 已集成但版本旧 → 更新
           */
          let statusCell: React.ReactNode;
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
                disabled={busy}
                onClick={() => handleHookUninstall(preset.id)}
              >
                {busy ? '…' : t('settings.uninstallHook')}
              </button>
            );
          } else if (hookStatus === 'outdated') {
            statusCell = (
              <button
                type="button"
                className="button button--small"
                disabled={busy}
                onClick={() => handleHookInstall(preset.id)}
              >
                {busy ? '…' : t('settings.integrationUpdate')}
              </button>
            );
          } else {
            statusCell = (
              <button
                type="button"
                className="button button--small"
                disabled={busy}
                onClick={() => handleHookInstall(preset.id)}
              >
                {busy ? '…' : t('settings.installHook')}
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
    </div>
  );
}
