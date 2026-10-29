/**
 * Devin CLI。
 *
 * 配置目录是**平台三态**（重构前 `integration/index.ts` 的 `devinDir()`）：
 * - `XDG_CONFIG_HOME` 有值时 → `<xdg>/devin`
 * - Windows 且 `APPDATA` 有值时 → `<appdata>/devin`
 * - 其余 → `~/.config/devin`
 *
 * 所有事件都用 `session` 动作：它只上报会话身份，状态由屏幕判定。
 */

import { devinManifest } from '../../detect/manifests/devin';
import type { AgentDescriptor } from '../descriptor';
import { expandTilde, joinPath } from '../spec/host';
import { hookArtifactPath, hookScriptName } from '../spec/integration-paths';
import { statePolicy } from '../spec/policy';
import { spacedTail } from '../spec/resume-spec';

/** 配置目录（对应 herdr `devin_dir`）。 */
export function devinDir(host: {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}): string {
  const xdg = host.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return joinPath(host, expandTilde(host, xdg), 'devin');
  if (host.platform === 'win32') {
    const appdata = host.env.APPDATA?.trim();
    if (appdata) return joinPath(host, appdata, 'devin');
  }
  return joinPath(host, host.home, '.config', 'devin');
}

export const devin: AgentDescriptor = {
  id: 'devin',
  detectionPriority: 60,
  label: 'Devin CLI',
  command: () => 'devin',

  detection: {
    identity: '\\bdevin\\b',
    aliases: ['devin-cli', 'devin cli'],
    manifest: devinManifest,
  },

  integration: {
    kind: 'json-hooks',
    version: 4,
    configDir: (host) => devinDir(host),
    artifactPath: (host) => hookArtifactPath(host, devinDir(host), null, hookScriptName(host)),
    hooks: {
      configFile: 'config.json',
      shape: 'nested',
      event: 'SessionStart',
      // 每个事件都带会话引用（action 全是 session，只锚会话不报状态）。
      stateEvents: [
        ['UserPromptSubmit', 'session'],
        ['PreToolUse', 'session'],
        ['PostToolUse', 'session'],
        ['PermissionRequest', 'session'],
        ['Stop', 'session'],
      ],
      // 旧版事件：安装/卸载时一并清理（对应 herdr DEVIN_REMOVED_LIFECYCLE_HOOK_EVENTS）。
      removedEvents: [
        ['UserPromptSubmit', 'working'],
        ['PreToolUse', 'working'],
        ['PostToolUse', 'working'],
        ['PermissionRequest', 'blocked'],
        ['Stop', 'idle'],
        ['SessionEnd', 'release'],
      ],
      timeout: 10,
      artifactSubdir: null,
    },
  },

  resume: {
    tail: spacedTail('--resume'),
  },

  policy: statePolicy({}),
};
