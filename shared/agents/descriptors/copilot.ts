/**
 * GitHub Copilot CLI。
 *
 * `direct` 形状的 JSON hook：条目是 `hooks[event] = [{ type: 'command', powershell|bash: command, timeoutSec }]`
 * —— 字段名随平台变，且超时单位是**秒**（与 qwen/letta/mastracode 的毫秒不同）。
 */

import { copilotManifest } from '../../detect/manifests/copilot';
import type { AgentDescriptor } from '../descriptor';
import { envOrHome } from '../spec/host';
import { hookArtifactPath, hookScriptName } from '../spec/integration-paths';
import { statePolicy } from '../spec/policy';
import { joinedTail } from '../spec/resume-spec';

export const copilot: AgentDescriptor = {
  id: 'copilot',
  detectionPriority: 120,
  label: 'GitHub Copilot CLI',
  command: () => 'copilot',

  detection: {
    identity: '\\b(?:copilot|github-copilot|ghcs)\\b',
    aliases: ['github-copilot', 'ghcs'],
    manifest: copilotManifest,
  },

  integration: {
    kind: 'json-hooks',
    version: 4,
    configDir: (host) => envOrHome(host, 'COPILOT_HOME', ['.copilot']),
    artifactPath: (host) =>
      hookArtifactPath(
        host,
        envOrHome(host, 'COPILOT_HOME', ['.copilot']),
        'hooks',
        hookScriptName(host),
      ),
    hooks: {
      configFile: 'settings.json',
      shape: 'direct',
      event: 'SessionStart',
      timeout: 10,
      artifactSubdir: 'hooks',
    },
  },

  resume: {
    tail: joinedTail('--resume'),
  },

  policy: statePolicy({}),
};
