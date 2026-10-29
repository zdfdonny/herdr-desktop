/**
 * Pi。
 *
 * 没有屏幕 manifest（全生命周期 hook 权威），集成是一个 TS 扩展文件，
 * 由 pi 从 `extensions/` 目录自动加载。会话引用可以用**文件路径**（`prefersPathRef`）。
 */

import { piManifest } from '../../detect/manifests/pi';
import type { AgentDescriptor } from '../descriptor';
import { envOrHome, joinPath } from '../spec/host';
import { statePolicy } from '../spec/policy';
import { spacedTail } from '../spec/resume-spec';

/** 扩展文件名。 */
export const PI_EXTENSION_FILE_NAME = 'herdr-desktop-agent-state.ts';

export const pi: AgentDescriptor = {
  id: 'pi',
  detectionPriority: 10,
  label: 'Pi',
  command: () => 'pi',

  detection: {
    identity: '\\bpi\\b',
    manifest: piManifest,
  },

  integration: {
    kind: 'extension',
    version: 4,
    configDir: (host) => envOrHome(host, 'PI_CODING_AGENT_DIR', ['.pi', 'agent']),
    artifactPath: (host) =>
      joinPath(
        host,
        envOrHome(host, 'PI_CODING_AGENT_DIR', ['.pi', 'agent']),
        'extensions',
        PI_EXTENSION_FILE_NAME,
      ),
  },

  resume: {

    replacementSources: ['new', 'resume', 'fork'],
    tail: spacedTail('--session'),
    prefersPathRef: true,
  },

  policy: statePolicy({ hookAuthority: 'full-lifecycle' }),
};
