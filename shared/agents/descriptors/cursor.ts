/**
 * Cursor Agent CLI。
 *
 * `simple` 形状的 JSON hook：条目就是 `{ command }`（无 type / timeout），
 * 且是唯一写 `version` 字段的集成。启动命令在 Windows 上是 npm 生成的
 * `.cmd` 垫片，所以命令要按平台解析。
 */

import { cursorManifest } from '../../detect/manifests/cursor';
import type { AgentDescriptor } from '../descriptor';
import { envOrHome } from '../spec/host';
import { hookArtifactPath, hookScriptName } from '../spec/integration-paths';
import { statePolicy } from '../spec/policy';
import { spacedTail } from '../spec/resume-spec';

export const cursor: AgentDescriptor = {
  id: 'cursor',
  detectionPriority: 50,
  label: 'Cursor Agent CLI',
  command: (host) => (host.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent'),

  detection: {
    identity: '\\bcursor(?:-agent)?\\b',
    aliases: ['cursor-agent'],
    manifest: cursorManifest,
  },

  integration: {
    kind: 'json-hooks',
    version: 4,
    configDir: (host) => envOrHome(host, 'CURSOR_CONFIG_DIR', ['.cursor']),
    artifactPath: (host) =>
      hookArtifactPath(
        host,
        envOrHome(host, 'CURSOR_CONFIG_DIR', ['.cursor']),
        null,
        hookScriptName(host),
      ),
    hooks: {
      configFile: 'hooks.json',
      shape: 'simple',
      event: 'sessionStart',
      withVersion: true,
      // 旧版 simple hooks：安装/卸载时一并清理（均用 session 命令）。
      removedEvents: [
        ['beforeSubmitPrompt', 'session'],
        ['beforeShellExecution', 'session'],
        ['beforeMCPExecution', 'session'],
        ['stop', 'session'],
        ['sessionEnd', 'session'],
      ],
      artifactSubdir: null,
    },
  },

  resume: {
    tail: spacedTail('--resume'),
  },

  policy: statePolicy({}),
};
