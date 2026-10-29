/**
 * Pi 的集成安装器装配。
 *
 * 冷门扩展目录 `$PI_CODING_AGENT_DIR/.pi/agent/extensions`；目录必须已存在
 * （由 pi 自己创建），不主动建。
 */

import { dirname, join } from 'node:path';
import type { IntegrationInstaller } from '../installer';
import { envOrHome, extensionTarget } from './kit';
import piAsset from '../assets/pi/herdr-desktop-agent-state.ts?raw';

/** pi 的扩展目录。 */
export function piExtensionDir(): string | null {
  return join(envOrHome('PI_CODING_AGENT_DIR', ['.pi', 'agent']), 'extensions');
}

/** 创建 pi 的集成安装器。 */
export function createPiTarget(): IntegrationInstaller {
  return extensionTarget({
    configDir: () => piExtensionDir(),
    asset: piAsset,
    fileName: 'herdr-desktop-agent-state.ts',
    requireDir: () => {
      const d = piExtensionDir();
      return d ? dirname(d) : null;
    },
    agentLabel: 'pi',
  });
}
