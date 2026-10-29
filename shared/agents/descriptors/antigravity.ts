/**
 * Antigravity CLI（`agy`）。
 *
 * 两处本质差异（重构前是 `shared/detect-manifest.ts:191` 与
 * `terminal-state.ts:2163` 的启动窗口机制）：
 * 1. **初始化是纯加载**：首屏只有 spinner / `esc to cancel`，没有任何交互证据，
 *    直到加载结束才画出 `? for shortcuts` 页脚。这段 working 没有信息量，照常写进
 *    状态机就会让初始化结束凭空产生一次 working → idle（并被当成完成、响提示音）。
 *    所以启动窗口必须生效 —— 它是唯一启用该机制的智能体；
 * 2. **完成只认 hook**：集成用 `PreInvocation` 上报 working、`Stop` + `fullyIdle`
 *    上报 idle。屏幕分不清「初始化完成 / 工具跑完 / 会话真的结束」，三者都表现为
 *    spinner 停下。
 *
 * 集成侧还有一个前置条件：配置目录必须已存在（由 CLI 首次启动创建），
 * 桌面端不主动建 —— 否则会造出一个 CLI 根本不认识的目录。
 */

import { antigravityManifest } from '../../detect/manifests/antigravity';
import type { AgentDescriptor } from '../descriptor';
import { envOrHome } from '../spec/host';
import { hookArtifactPath, hookScriptName } from '../spec/integration-paths';
import { statePolicy } from '../spec/policy';
import { spacedTail } from '../spec/resume-spec';

export const antigravity: AgentDescriptor = {
  id: 'antigravity',
  detectionPriority: 70,
  label: 'Antigravity CLI',
  command: () => 'agy',

  detection: {
    identity: '\\b(?:agy|antigravity)\\b',
    // `agy` 既是启动命令也是别名：识别正则认得它，标签归一也要认得它。
    aliases: ['agy', 'antigravity-cli'],
    manifest: antigravityManifest,
  },

  integration: {
    kind: 'json-hooks',
    version: 6,
    configDir: (host) => envOrHome(host, 'ANTIGRAVITY_CLI_CONFIG_DIR', ['.gemini', 'config']),
    artifactPath: (host) =>
      hookArtifactPath(
        host,
        envOrHome(host, 'ANTIGRAVITY_CLI_CONFIG_DIR', ['.gemini', 'config']),
        'hooks',
        hookScriptName(host),
      ),
  },

  resume: {

    replacementSources: [''],
    tail: spacedTail('--conversation'),
  },

  policy: statePolicy({
    hookAuthority: 'state',
    screenOwnsCompletion: false,
    ignoreStartupWorking: true,
    completionRequiresIntegration: true,
  }),
};
