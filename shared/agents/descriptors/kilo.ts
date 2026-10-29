/**
 * Kilo Code CLI。
 *
 * 扩展型，但产物在 `plugin/` 子目录里（其余 extension 型都在 `extensions/`）。
 * 重构前这里有个真实缺陷：安装时只 `mkdir(configDir)`，没建 `plugin/` 子目录，
 * 首次安装会 ENOENT —— 安装器现在会按产物路径建父目录。
 */

import { kiloManifest } from '../../detect/manifests/kilo';
import type { AgentDescriptor } from '../descriptor';
import { joinPath } from '../spec/host';
import { statePolicy } from '../spec/policy';
import { spacedTail } from '../spec/resume-spec';

/** 插件文件名（含 `plugin/` 子目录）。 */
export const KILO_PLUGIN_FILE_NAME = 'plugin/herdr-desktop-agent-state.js';

export const kilo: AgentDescriptor = {
  id: 'kilo',
  detectionPriority: 190,
  label: 'Kilo Code CLI',
  command: () => 'kilo',

  detection: {
    identity: '\\bkilo\\b',
    aliases: ['kilo-code', 'kilo code'],
    manifest: kiloManifest,
  },

  integration: {
    kind: 'extension',
    version: 4,
    configDir: (host) => joinPath(host, host.home, '.config', 'kilo'),
    artifactPath: (host) =>
      joinPath(host, host.home, '.config', 'kilo', 'plugin', 'herdr-desktop-agent-state.js'),
  },

  resume: {
    tail: spacedTail('--session'),
  },

  policy: statePolicy({ hookAuthority: 'full-lifecycle' }),
};
