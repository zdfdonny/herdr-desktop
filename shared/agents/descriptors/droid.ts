/**
 * Factory Droid CLI。`nested` 形状的 JSON hook，配置在 `~/.factory/settings.json`。
 */

import { droidManifest } from '../../detect/manifests/droid';
import type { AgentDescriptor } from '../descriptor';
import { joinPath } from '../spec/host';
import { hookArtifactPath, hookScriptName } from '../spec/integration-paths';
import { statePolicy } from '../spec/policy';
import { spacedTail } from '../spec/resume-spec';

export const droid: AgentDescriptor = {
  id: 'droid',
  detectionPriority: 150,
  label: 'Droid',
  command: () => 'droid',

  detection: {
    identity: '\\bdroid\\b',
    manifest: droidManifest,
  },

  integration: {
    kind: 'json-hooks',
    version: 4,
    configDir: (host) => joinPath(host, host.home, '.factory'),
    artifactPath: (host) =>
      hookArtifactPath(host, joinPath(host, host.home, '.factory'), 'hooks', hookScriptName(host)),
    hooks: {
      configFile: 'settings.json',
      shape: 'nested',
      event: 'SessionStart',
      // 旧版事件：安装/卸载时一并清理（对应 herdr DROID_REMOVED_LIFECYCLE_HOOK_EVENTS）。
      removedEvents: [
        ['SessionStart', 'idle'],
        ['UserPromptSubmit', 'working'],
        ['PreToolUse', 'working'],
        ['PostToolUse', 'working'],
        ['Notification', 'blocked'],
        ['Stop', 'idle'],
        ['SubagentStop', 'working'],
        ['PreCompact', 'working'],
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
