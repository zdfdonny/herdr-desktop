/**
 * Qoder CLI。配置在 `~/.qoder/settings.json`，hook 的 matcher 固定为 `*`。
 */

import { qodercliManifest } from '../../detect/manifests/qodercli';
import type { AgentDescriptor } from '../descriptor';
import { envOrHome } from '../spec/host';
import { hookArtifactPath, hookScriptName } from '../spec/integration-paths';
import { statePolicy } from '../spec/policy';
import { spacedTail } from '../spec/resume-spec';

export const qodercli: AgentDescriptor = {
  id: 'qodercli',
  detectionPriority: 200,
  label: 'Qoder CLI',
  command: () => 'qodercli',

  detection: {
    identity: '\\b(?:qodercli|qoder)\\b',
    aliases: ['qoder', 'qoderclicn', 'qodercn'],
    manifest: qodercliManifest,
  },

  integration: {
    kind: 'json-hooks',
    version: 4,
    configDir: (host) => envOrHome(host, 'QODER_CONFIG_DIR', ['.qoder']),
    artifactPath: (host) =>
      hookArtifactPath(
        host,
        envOrHome(host, 'QODER_CONFIG_DIR', ['.qoder']),
        'hooks',
        hookScriptName(host),
      ),
    hooks: {
      configFile: 'settings.json',
      shape: 'nested',
      event: 'SessionStart',
      matcher: '*',
      // 旧版事件：安装/卸载时一并清理（对应 herdr QODERCLI_REMOVED_LIFECYCLE_HOOK_EVENTS）。
      removedEvents: [
        ['SessionStart', 'idle'],
        ['UserPromptSubmit', 'working'],
        ['PreToolUse', 'working'],
        ['PostToolUse', 'working'],
        ['PostToolUseFailure', 'working'],
        ['SubagentStart', 'working'],
        ['SubagentStop', 'working'],
        ['PreCompact', 'working'],
        ['Notification', 'blocked'],
        ['PermissionRequest', 'blocked'],
        ['Stop', 'idle'],
        ['SessionEnd', 'release'],
      ],
      timeout: 10,
      artifactSubdir: 'hooks',
    },
  },

  resume: {
    tail: spacedTail('--resume'),
  },

  policy: statePolicy({}),
};
