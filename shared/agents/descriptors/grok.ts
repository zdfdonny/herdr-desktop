/**
 * Grok CLI。
 *
 * 两个特别之处：
 * - 集成写的是**独占文件** `hooks/herdr-desktop.json`（不碰用户的其它配置），
 *   且状态判定要求「配置与期望完全一致」，漂移即报 outdated；
 * - 会话接管上被**排除**在「前台 pane 可抢占他人会话」之外
 *   （重构前 `terminal-state.ts:1943` 的内联例外）。
 */

import { grokManifest } from '../../detect/manifests/grok';
import type { AgentDescriptor } from '../descriptor';
import { envOrHome, expandTilde, joinPath } from '../spec/host';
import { hookArtifactPath, hookScriptName } from '../spec/integration-paths';
import { statePolicy } from '../spec/policy';
import { spacedTail } from '../spec/resume-spec';

/** 配置目录：`GROK_CONFIG_DIR` → `GROK_HOME` → `~/.grok`。 */
export function grokDir(host: {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}): string {
  const override = host.env.GROK_CONFIG_DIR?.trim();
  if (override) return expandTilde(host, override);
  return envOrHome(host, 'GROK_HOME', ['.grok']);
}

/** grok 独占的 hook 配置文件路径。 */
export function grokConfigPath(host: {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}): string {
  return joinPath(host, grokDir(host), 'hooks', 'herdr-desktop.json');
}

export const grok: AgentDescriptor = {
  id: 'grok',
  detectionPriority: 170,
  label: 'Grok CLI',
  command: () => 'grok',

  detection: {
    identity: '\\bgrok\\b',
    aliases: ['grok-build'],
    manifest: grokManifest,
  },

  integration: {
    kind: 'json-hooks',
    version: 4,
    configDir: (host) => grokDir(host),
    artifactPath: (host) =>
      hookArtifactPath(host, grokDir(host), 'hooks', hookScriptName(host)),
  },

  resume: {

    replacementSources: ['new'],
    tail: spacedTail('--resume'),
  },

  policy: statePolicy({
    sessionRebinding: { mode: 'default', allowForegroundTakeover: false },
  }),
};
