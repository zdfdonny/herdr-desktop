/**
 * OMP 的集成安装器装配。
 *
 * 与 pi 同为扩展型、同用 `PI_CODING_AGENT_DIR`，但目录规则不同：
 * pi 是 `<base>/extensions`，omp 在无 `PI_CODING_AGENT_DIR` 时是
 * `<PI_CONFIG_DIR | ~/.omp>/agent/extensions`（多一层 `agent`）。
 * 混淆这两条规则会让扩展装到 pi 读不到的位置。
 */

import { dirname, join } from 'node:path';
import type { IntegrationInstaller } from '../installer';
import { expandTilde, extensionTarget, homeJoin } from './kit';
import ompAsset from '../assets/omp/herdr-desktop-omp-agent-state.ts?raw';

/** omp 的扩展目录。 */
export function ompExtensionDir(): string | null {
  // 对应 herdr omp_extension_dir：PI_CODING_AGENT_DIR 直接接 extensions（无 agent 段），
  // 否则用 PI_CONFIG_DIR/~/.omp 再接 agent/extensions。
  const piDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (piDir) return join(expandTilde(piDir), 'extensions');
  const base = expandTilde(process.env.PI_CONFIG_DIR?.trim() || homeJoin('.omp'));
  return join(base, 'agent', 'extensions');
}

/** 创建 omp 的集成安装器。 */
export function createOmpTarget(): IntegrationInstaller {
  return extensionTarget({
    configDir: () => ompExtensionDir(),
    asset: ompAsset,
    fileName: 'herdr-desktop-omp-agent-state.ts',
    requireDir: () => {
      const d = ompExtensionDir();
      return d ? dirname(d) : null;
    },
    agentLabel: 'omp',
  });
}
