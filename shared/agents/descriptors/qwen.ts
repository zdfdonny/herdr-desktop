/**
 * Qwen Code。
 *
 * 两个特别之处：
 * - 集成**只上报会话身份**（`hookAuthority: 'none'`），状态完全由屏幕判定；
 * - 用的是「会话专用脚本」（`herdr-desktop-agent-session.*`）而不是通用的
 *   `*-agent-state.*`，超时单位是**毫秒**（`10000`），与其它 agent 的秒混用。
 */

import { qwenManifest } from '../../detect/manifests/qwen';
import type { AgentDescriptor } from '../descriptor';
import { envOrHome } from '../spec/host';
import { hookArtifactPath, sessionScriptName } from '../spec/integration-paths';
import { statePolicy } from '../spec/policy';
import { spacedTail } from '../spec/resume-spec';

export const qwen: AgentDescriptor = {
  id: 'qwen',
  detectionPriority: 210,
  label: 'Qwen Code',
  command: () => 'qwen',

  detection: {
    identity: '\\bqwen\\b',
    aliases: ['qwen-code', 'qwen code'],
    manifest: qwenManifest,
  },

  integration: {
    kind: 'json-hooks',
    version: 4,
    configDir: (host) => envOrHome(host, 'QWEN_HOME', ['.qwen']),
    artifactPath: (host) =>
      hookArtifactPath(
        host,
        envOrHome(host, 'QWEN_HOME', ['.qwen']),
        'hooks',
        sessionScriptName(host),
      ),
    hooks: {
      configFile: 'settings.json',
      shape: 'nested',
      event: 'SessionStart',
      matcher: '*',
      timeout: 10000,
      artifactSubdir: 'hooks',
      sessionScript: true,
    },
  },

  resume: {
    tail: spacedTail('--resume'),
    /*
     * qwen 的集成**只上报会话身份**（`hookAuthority: 'none'`），会话引用是它唯一的
     * 输出，所以这些启动来源必须放行替换 —— 否则 /clear、--resume、branch 之后
     * pane 仍钉在旧会话上，重启会续回错的对话。
     * 对应重构前 `SESSION_REPLACEMENT_ALLOWED` 里的 qwen 五行。
     */
    replacementSources: ['startup', 'clear', 'resume', 'compact', 'branch'],
  },

  policy: statePolicy({ hookAuthority: 'none' }),
};
