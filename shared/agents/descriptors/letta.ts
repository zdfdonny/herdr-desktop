/**
 * Letta Code。
 *
 * 只上报会话身份（状态由屏幕判定）。集成用会话专用脚本，且带 `quiet: true`
 * （hook 不向终端输出任何内容，避免污染 TUI）。
 *
 * 会话引用可能带 `default:` 前缀（形如 `default:<agentId>`），
 * 此时恢复命令要拆成 `--conversation default --agent <id>`。
 */

import { lettaManifest } from '../../detect/manifests/letta';
import type { AgentDescriptor } from '../descriptor';
import { joinPath } from '../spec/host';
import { hookArtifactPath, sessionScriptName } from '../spec/integration-paths';
import { statePolicy } from '../spec/policy';

/** 会话引用里的「默认会话」前缀。 */
const LETTA_DEFAULT_PREFIX = 'default:';

export const letta: AgentDescriptor = {
  id: 'letta',
  detectionPriority: 220,
  label: 'Letta Code',
  command: () => 'letta',

  detection: {
    identity: '\\bletta\\b',
    aliases: ['letta-code', 'letta code'],
    manifest: lettaManifest,
  },

  integration: {
    kind: 'json-hooks',
    version: 4,
    configDir: (host) => joinPath(host, host.home, '.letta'),
    artifactPath: (host) =>
      hookArtifactPath(host, joinPath(host, host.home, '.letta'), 'hooks', sessionScriptName(host)),
    hooks: {
      configFile: 'settings.json',
      shape: 'nested',
      event: 'SessionStart',
      timeout: 10000,
      quiet: true,
      artifactSubdir: 'hooks',
      sessionScript: true,
    },
  },

  resume: {
    tail: (ref) => {
      if (ref.kind !== 'id') return null;
      if (!ref.value.startsWith(LETTA_DEFAULT_PREFIX)) {
        return ['--conversation', ref.value];
      }
      const agentId = ref.value.slice(LETTA_DEFAULT_PREFIX.length);
      if (agentId.length === 0) return null;
      return ['--conversation', 'default', '--agent', agentId];
    },
  },

  policy: statePolicy({ hookAuthority: 'none' }),
};
