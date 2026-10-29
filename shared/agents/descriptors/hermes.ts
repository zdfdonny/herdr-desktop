/**
 * Hermes Agent。
 *
 * 唯一用 **Python 插件**的集成：写一个插件目录（`plugin.yaml` + `__init__.py`），
 * 再在 `config.yaml` 的 `plugins.enabled` 里启用它（手写 YAML 行编辑）。
 *
 * 只上报会话身份，状态由屏幕判定。目录解析是平台多态：
 * `HERMES_HOME` → (Windows 且 `HOME ≠ USERPROFILE`) `~/.hermes` →
 * `LOCALAPPDATA/hermes` → `~/.hermes`。
 */

import { hermesManifest } from '../../detect/manifests/hermes';
import type { AgentDescriptor } from '../descriptor';
import { expandTilde, joinPath } from '../spec/host';
import { statePolicy } from '../spec/policy';
import { spacedTail } from '../spec/resume-spec';

/** 插件目录名。 */
export const HERMES_PLUGIN_DIR_NAME = 'herdr-desktop-agent-state';

/** 配置目录（对应 herdr `hermes_dir`）。 */
export function hermesDir(host: {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}): string {
  const env = host.env.HERMES_HOME?.trim();
  if (env) return expandTilde(host, env);
  if (host.platform === 'win32') {
    const home = host.env.HOME?.trim();
    const profile = host.env.USERPROFILE?.trim();
    if (home && home !== profile) return joinPath(host, home, '.hermes');
    const localAppData = host.env.LOCALAPPDATA?.trim();
    if (localAppData) return joinPath(host, localAppData, 'hermes');
  }
  return joinPath(host, host.home, '.hermes');
}

export const hermes: AgentDescriptor = {
  id: 'hermes',
  detectionPriority: 180,
  label: 'Hermes Agent',
  command: () => 'hermes',

  detection: {
    identity: '\\bhermes\\b',
    aliases: ['hermes-agent'],
    manifest: hermesManifest,
  },

  integration: {
    kind: 'plugin',
    version: 3,
    configDir: (host) => hermesDir(host),
    artifactPath: (host) =>
      joinPath(host, hermesDir(host), 'plugins', HERMES_PLUGIN_DIR_NAME, '__init__.py'),
  },

  resume: {

    replacementSources: ['startup', 'new', 'resume'],
    tail: spacedTail('--resume'),
  },

  policy: statePolicy({ hookAuthority: 'none' }),
};
