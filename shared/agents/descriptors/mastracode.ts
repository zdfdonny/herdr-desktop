/**
 * MastraCode。
 *
 * 会话语义特殊（重构前 `terminal-state.ts` 的
 * `lifecycleHookReportReplacesPersistedSession`）：它是唯一允许「无 hook 权威时，
 * 会话上报直接覆盖已持久化会话」的智能体 —— 其它智能体在这种情形下要保守地忽略。
 *
 * 集成用 flat 形状写 `hooks.json`（`hooks[event] = [{ type, command, timeout, description }]`），
 * 且命令以 PowerShell `-EncodedCommand` 形式编码（避免引号注入）。
 */

import type { AgentDescriptor } from '../descriptor';
import { joinPath } from '../spec/host';
import { hookArtifactPath, hookScriptName } from '../spec/integration-paths';
import { statePolicy } from '../spec/policy';
import { spacedTail } from '../spec/resume-spec';

export const mastracode: AgentDescriptor = {
  id: 'mastracode',
  detectionPriority: 100,
  label: 'MastraCode',
  command: () => 'mastracode',

  detection: {
    // mastracode 没有屏幕 manifest：它是全生命周期 hook 权威，状态只由 hook 提供。
    identity: '\\b(?:mastracode|mastra)\\b',
    aliases: ['mastra-code', 'mastra code'],
  },

  integration: {
    kind: 'json-hooks',
    version: 4,
    configDir: (host) => joinPath(host, host.home, '.mastracode'),
    artifactPath: (host) =>
      hookArtifactPath(
        host,
        joinPath(host, host.home, '.mastracode'),
        'hooks',
        hookScriptName(host),
      ),
    hooks: {
      configFile: 'hooks.json',
      shape: 'flat',
      event: 'SessionStart',
      // 额外状态事件（对应 herdr MASTRACODE_HOOK_EVENTS，除去 SessionStart）。
      stateEvents: [
        ['UserPromptSubmit', 'working'],
        ['AgentStart', 'working'],
        ['PreToolUse', 'working'],
        ['PermissionRequest', 'blocked'],
        ['PermissionResult', 'working'],
        ['SubagentStart', 'working'],
        ['SubagentEnd', 'working'],
        ['Interrupt', 'idle'],
        ['AgentEnd', 'idle'],
        ['Stop', 'idle'],
      ],
      removedEvents: [
        ['SessionStart', 'idle'],
        ['SessionEnd', 'release'],
      ],
      timeout: 10000,
      encodedCommand: true,
      artifactSubdir: 'hooks',
    },
  },

  resume: {
    tail: spacedTail('--thread'),
    /*
     * 对应重构前 `SESSION_REPLACEMENT_ALLOWED` 里的
     * `herdr:mastracode\0mastracode\0startup`：SessionStart 上报的会话引用
     * 允许替换当前绑定，否则启动后 pane 会停在恢复出来的旧线程上。
     */
    replacementSources: ['startup'],
  },

  policy: statePolicy({
    hookAuthority: 'full-lifecycle',
    sessionRebinding: { mode: 'overwrite-persisted', allowForegroundTakeover: true },
  }),
};
