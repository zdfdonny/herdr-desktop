/**
 * OMP。
 *
 * 与 pi 同为扩展型、同用 `PI_CODING_AGENT_DIR`，但目录规则不同：
 * pi 是 `<base>/extensions`，omp 在无 `PI_CODING_AGENT_DIR` 时是
 * `<PI_CONFIG_DIR | ~/.omp>/agent/extensions`（多一层 `agent`）。
 * 混淆这两条规则会让扩展装到 pi 读不到的位置。
 */

import type { AgentDescriptor } from '../descriptor';
import { expandTilde, joinPath } from '../spec/host';
import { statePolicy } from '../spec/policy';
import { joinedTail } from '../spec/resume-spec';

/** 扩展文件名（注意与 pi 的 `herdr-desktop-agent-state.ts` 不同）。 */
export const OMP_EXTENSION_FILE_NAME = 'herdr-desktop-omp-agent-state.ts';

/**
 * 扩展所在目录的**父目录**：`<base>/extensions` 里的 `<base>`。
 *
 * 有 `PI_CODING_AGENT_DIR` 时 → 该目录；否则 `<PI_CONFIG_DIR | ~/.omp>/agent`。
 */
export function ompBaseDir(host: {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}): string {
  const piDir = host.env.PI_CODING_AGENT_DIR?.trim();
  if (piDir) return expandTilde(host, piDir);
  const configDir = host.env.PI_CONFIG_DIR?.trim();
  const base = configDir ? expandTilde(host, configDir) : joinPath(host, host.home, '.omp');
  return joinPath(host, base, 'agent');
}

export const omp: AgentDescriptor = {
  id: 'omp',
  detectionPriority: 90,
  label: 'OMP',
  command: () => 'omp',

  detection: {
    // 没有屏幕 manifest：全生命周期 hook 权威。
    identity: '\\bomp\\b',
  },

  integration: {
    kind: 'extension',
    version: 5,
    configDir: (host) => ompBaseDir(host),
    artifactPath: (host) =>
      joinPath(host, ompBaseDir(host), 'extensions', OMP_EXTENSION_FILE_NAME),
  },

  resume: {

    replacementSources: ['startup', 'new', 'resume', 'fork'],
    tail: joinedTail('--resume'),
    prefersPathRef: true,
  },

  policy: statePolicy({ hookAuthority: 'full-lifecycle' }),
};
