/**
 * Kimi Code CLI。
 *
 * 集成实现最特殊的一个（重构前 `integration/index.ts:943`）：
 * - 配置是 **TOML**（`config.toml` 里的 `[[hooks]]` 块），用块标记包裹，
 *   卸载时按标记整块移除 —— 不能像 JSON 那样按 path 定位；
 * - 安装前会跑 `kimi --version` 做**最低版本闸门**（hooks 需要 0.14.0+），
 *   太旧直接抛错阻断，避免装上一个 CLI 不认识的配置；
 * - 事件带 matcher，用来把 `AskUserQuestion` 与其它工具分流成 blocked / working。
 */

import { kimiManifest } from '../../detect/manifests/kimi';
import type { AgentDescriptor } from '../descriptor';
import { envOrHome } from '../spec/host';
import { hookArtifactPath, hookScriptName } from '../spec/integration-paths';
import { statePolicy } from '../spec/policy';
import { spacedTail } from '../spec/resume-spec';

/** hooks 所需的最低 kimi 版本（对应 herdr 的版本约束）。 */
export const KIMI_MIN_VERSION = '0.14.0';

export const kimi: AgentDescriptor = {
  id: 'kimi',
  detectionPriority: 130,
  label: 'Kimi Code CLI',
  command: () => 'kimi',

  detection: {
    identity: '\\bkimi\\b',
    aliases: ['kimi-code', 'kimi code'],
    manifest: kimiManifest,
  },

  integration: {
    kind: 'json-hooks',
    version: 4,
    configDir: (host) => envOrHome(host, 'KIMI_CODE_HOME', ['.kimi-code']),
    artifactPath: (host) =>
      hookArtifactPath(
        host,
        envOrHome(host, 'KIMI_CODE_HOME', ['.kimi-code']),
        'hooks',
        hookScriptName(host),
      ),
  },

  resume: {
    tail: spacedTail('--session'),
  },

  policy: statePolicy({ hookAuthority: 'full-lifecycle' }),
};
