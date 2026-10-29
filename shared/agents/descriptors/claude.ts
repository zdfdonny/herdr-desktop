/**
 * Claude Code —— 状态权威交给 hook 的典型代表。
 *
 * 策略要点（重构前散在 `shared/detect-manifest.ts` 与 `terminal-state.ts`）：
 * - 集成 v4 起用 `Stop` 上报 idle、`UserPromptSubmit` 上报 working、`PostToolUse`
 *   上报**心跳式** working，因此屏幕不再参与「完成」判定 —— 否则 `/resume`、
 *   `/clear`、工具跑完都会误响一次完成提示音（这三者在屏幕上都是 working → idle）；
 * - `PostToolUse` 走异步、`Stop` 是同步的，迟到心跳会把已完成的 pane 顶回 working，
 *   所以必须接受 heartbeat 语义并做陈旧性过滤；
 * - 「完成交给 hook」有一个前提：集成**确实装了**。没装时 hook 永远不会上报 idle，
 *   必须退回屏幕判定，否则这个智能体就再也不会响完成提示音。
 */

import { claudeManifest } from '../../detect/manifests/claude';
import type { AgentDescriptor } from '../descriptor';
import { envOrHome } from '../spec/host';
import { hookArtifactPath, hookScriptName } from '../spec/integration-paths';
import { statePolicy } from '../spec/policy';
import { spacedTail } from '../spec/resume-spec';

export const claude: AgentDescriptor = {
  id: 'claude',
  detectionPriority: 20,
  label: 'Claude Code',
  command: () => 'claude',

  detection: {
    identity: '\\bclaude(?:-code)?\\b',
    aliases: ['claude-code'],
    manifest: claudeManifest,
  },

  integration: {
    kind: 'json-hooks',
    version: 5,
    configDir: (host) => envOrHome(host, 'CLAUDE_CONFIG_DIR', ['.claude']),
    artifactPath: (host) =>
      hookArtifactPath(
        host,
        envOrHome(host, 'CLAUDE_CONFIG_DIR', ['.claude']),
        'hooks',
        hookScriptName(host),
      ),
    hooks: {
      configFile: 'settings.json',
      shape: 'nested',
      event: 'SessionStart',
      /*
       * 事件集（对应 Claude Code hooks 文档）。逐事件 `background` 语义：
       * - UserPromptSubmit / PostToolUse 一轮里触发很多次，同步执行等于给每次工具调用
       *   都加一次进程启动延迟（Windows 上尤其明显），所以走异步；
       * - Stop / StopFailure 一轮只触发一次，且 idle 是唯一的完成信号，必须同步执行，
       *   否则异步进程可能在状态落地前被回收，完成提示音就丢了；
       * - SessionStart 每个会话只有一次，保持同步。
       *
       * PostToolUse 用 `tick` 而不是 `working`：它上报的是带 `heartbeat: true` 的 working，
       * 只允许刷新还在工作的 pane，不能把已完成的 pane 拉回 working。
       */
      stateEvents: [
        ['UserPromptSubmit', 'working', { background: true }],
        ['PostToolUse', 'tick', { background: true }],
        ['Stop', 'idle'],
        ['StopFailure', 'failed'],
      ],
      // 旧版事件：安装/卸载时一并清理（对应 herdr HOOK_REMOVALS）。
      removedEvents: [
        ['PostToolUse', 'working'],
        ['PreToolUse', 'working'],
        ['PostToolUseFailure', 'working'],
        ['SubagentStop', 'working'],
        ['PermissionRequest', 'blocked'],
        ['SessionStart', 'idle'],
        ['SessionEnd', 'release'],
      ],
      matcher: '^(startup|resume|clear|compact|fork)$',
      timeout: 10,
      artifactSubdir: 'hooks',
    },
  },

  resume: {
    replacementSources: ['clear', 'resume', 'compact', 'fork', ''],
    tail: spacedTail('--resume'),
  },

  policy: statePolicy({
    hookAuthority: 'state',
    screenOwnsCompletion: false,
    acceptsHeartbeat: true,
    completionRequiresIntegration: true,
  }),
};
