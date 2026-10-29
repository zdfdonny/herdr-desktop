/**
 * Kilo Code CLI 的集成安装器装配。
 *
 * 扩展型，但产物在 `plugin/` 子目录里（pi / omp 都在 `extensions/`），
 * 且要求 `~/.config/kilo` 目录已存在（由 kilo 自己创建）。
 */

import { join } from 'node:path';
import type { IntegrationInstaller } from '../installer';
import { extensionTarget, homeJoin } from './kit';
import kiloAsset from '../assets/kilo/herdr-desktop-agent-state.js?raw';

/** kilo 的配置目录。 */
function kiloConfigDir(): string {
  return homeJoin('.config', 'kilo');
}

/** 创建 kilo 的集成安装器。 */
export function createKiloTarget(): IntegrationInstaller {
  return extensionTarget({
    configDir: () => kiloConfigDir(),
    asset: kiloAsset,
    fileName: join('plugin', 'herdr-desktop-agent-state.js'),
    requireDir: () => kiloConfigDir(),
    agentLabel: 'kilo',
  });
}
