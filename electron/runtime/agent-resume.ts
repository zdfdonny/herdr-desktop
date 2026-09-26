/**
 * agent 会话恢复 —— 对应 herdr `src/agent_resume.rs`。
 *
 * 把「来源 + agent + 会话引用」翻译成该 agent 的恢复命令 argv。
 * 设计要点（与 herdr 一致）：
 * - 只接受官方来源（`herdr:<agent>`），自定义命令一律不参与恢复；
 * - id/path 做防御性校验，避免把会话文件/终端里的不可信内容拼进 shell；
 * - 恢复命令表集中在 `resumeTail`，每个 agent 的 flag 各不相同。
 */

import { isAbsolute } from 'node:path';
import type { AgentSessionRefKind, PaneAgentSession } from '../../shared/state';

export const MAX_SESSION_ID_LEN = 512;
export const MAX_SESSION_PATH_LEN = 4096;

/**
 * 恢复开关（对应 herdr `[session] resume_agents_on_restore`，默认 true）。
 *
 * 目前先做成常量，避免把设置项铺到 SettingsStore / 设置 UI / i18n；
 * 需要可配置时再把它接进 AppSettings。
 */
export const RESUME_AGENTS_ON_RESTORE = true;

/** 官方恢复白名单（herdr-desktop 的 agent id）。 */
const OFFICIAL_AGENTS = new Set([
  'pi',
  'claude',
  'codex',
  'cursor',
  'devin',
  'antigravity',
  'omp',
  'mastracode',
  'opencode',
  'copilot',
  'kimi',
  'droid',
  'grok',
  'hermes',
  'kilo',
  'qodercli',
  'qwen',
  'letta',
]);

export interface AgentSessionRef {
  kind: AgentSessionRefKind;
  value: string;
}

export interface AgentResumePlan {
  agent: string;
  argv: string[];
  dedupeKey: string;
}

export interface PersistedAgentSession {
  source: string;
  agent: string;
  sessionRef: AgentSessionRef;
}

/** 会话 id 校验：非空、长度受限、不含控制字符（防 shell 注入）。 */
export function validSessionId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_SESSION_ID_LEN &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** 会话文件路径校验：非空、绝对路径、不含控制字符。 */
export function validSessionPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_SESSION_PATH_LEN &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    isAbsolute(value)
  );
}

export function sessionRefId(value: string): AgentSessionRef | null {
  return validSessionId(value) ? { kind: 'id', value } : null;
}

export function sessionRefPath(value: string): AgentSessionRef | null {
  return validSessionPath(value) ? { kind: 'path', value } : null;
}

/** 官方来源校验（对应 herdr `is_official_agent_source`）。 */
export function isOfficialAgentSource(source: string, agent: string): boolean {
  return source === `herdr:${agent}` && OFFICIAL_AGENTS.has(agent);
}

/**
 * 官方集成上报的 session 引用（对应 herdr `session_ref_from_report`）。
 *
 * pi/omp 优先用 session 文件路径，回退到 id；其余 agent 只用 id。
 */
export function sessionRefFromReport(
  source: string,
  agent: string,
  agentSessionId: string | null,
  agentSessionPath: string | null,
): AgentSessionRef | null {
  if (!isOfficialAgentSource(source, agent)) return null;

  if (agent === 'pi' || agent === 'omp') {
    return (
      (agentSessionPath != null ? sessionRefPath(agentSessionPath) : null) ??
      (agentSessionId != null ? sessionRefId(agentSessionId) : null)
    );
  }

  return agentSessionId != null ? sessionRefId(agentSessionId) : null;
}

/**
 * 从启动参数反推会话（对应 herdr `persisted_session_from_launch_args`）。
 *
 * 目前只覆盖 codex 的 `codex resume <id>` 形态；`--last` 等非显式 id 不算。
 */
export function persistedSessionFromLaunchArgs(
  agent: string,
  args: string[],
): PersistedAgentSession | null {
  if (agent !== 'codex' || args.length !== 2) return null;
  const [command, sessionId] = args;
  if (command !== 'resume' || sessionId.startsWith('-')) return null;
  const sessionRef = sessionRefId(sessionId);
  if (!sessionRef) return null;
  return { source: 'herdr:codex', agent: 'codex', sessionRef };
}

/**
 * 从持久化快照恢复会话（对应 herdr `session_ref_from_snapshot`）。
 */
export function sessionRefFromSnapshot(
  source: string,
  agent: string,
  kind: AgentSessionRefKind,
  value: string,
): PersistedAgentSession | null {
  if (!isOfficialAgentSource(source, agent)) return null;
  const sessionRef =
    (agent === 'pi' || agent === 'omp') && kind === 'path'
      ? sessionRefPath(value)
      : kind === 'id'
        ? sessionRefId(value)
        : null;
  if (!sessionRef) return null;
  return { source, agent, sessionRef };
}

/** 去重键（对应 herdr `dedupe_key`）：同一会话不允许被两个 pane 同时恢复。 */
export function dedupeKey(source: string, agent: string, sessionRef: AgentSessionRef): string {
  return `${source}\u0000${agent}\u0000${sessionRef.kind}\u0000${sessionRef.value}`;
}

/**
 * 生成恢复命令 argv（对应 herdr `plan`）。
 *
 * `executable` 由调用方传入（通常是 pane 记录的启动命令首 token），
 * 这样 cursor 在 Windows 上的 `.cmd` 后缀等平台差异由既有逻辑负责。
 */
export function plan(
  source: string,
  agent: string,
  sessionRef: AgentSessionRef,
  executable: string,
): AgentResumePlan | null {
  if (!isOfficialAgentSource(source, agent)) return null;
  const tail = resumeTail(agent, sessionRef);
  if (!tail) return null;
  return {
    agent,
    argv: [executable, ...tail],
    dedupeKey: dedupeKey(source, agent, sessionRef),
  };
}

/** 从持久化的 PaneAgentSession 直接生成恢复计划（router 恢复路径使用）。 */
export function resumePlanForPane(
  executable: string,
  session: PaneAgentSession,
): AgentResumePlan | null {
  const sessionRef =
    session.kind === 'path' ? sessionRefPath(session.value) : sessionRefId(session.value);
  if (!sessionRef) return null;
  return plan(session.source, session.agent, sessionRef, executable);
}

/**
 * 按 agent 分型的恢复命令尾（不含 argv[0]）。
 *
 * 直接对应 herdr `agent_resume.rs` 的 `plan` 表：
 * claude→--resume、codex→resume、opencode→--session、kilo→--session、
 * pi/omp→--session/--resume=（id 或 path）、letta→--conversation 等。
 */
function resumeTail(agent: string, sessionRef: AgentSessionRef): string[] | null {
  switch (agent) {
    case 'claude':
      return ['--resume', sessionRef.value];
    case 'codex':
      return ['resume', sessionRef.value];
    case 'copilot':
      return [`--resume=${sessionRef.value}`];
    case 'devin':
    case 'droid':
    case 'hermes':
    case 'qodercli':
    case 'qwen':
    case 'grok':
      return ['--resume', sessionRef.value];
    case 'kimi':
    case 'pi':
    case 'opencode':
    case 'kilo':
      return ['--session', sessionRef.value];
    case 'omp':
      return [`--resume=${sessionRef.value}`];
    case 'mastracode':
      return ['--thread', sessionRef.value];
    case 'cursor':
      return ['--resume', sessionRef.value];
    case 'antigravity':
      return ['--conversation', sessionRef.value];
    case 'letta': {
      const prefix = 'default:';
      if (sessionRef.value.startsWith(prefix)) {
        const agentId = sessionRef.value.slice(prefix.length);
        if (agentId.length === 0) return null;
        return ['--conversation', 'default', '--agent', agentId];
      }
      return ['--conversation', sessionRef.value];
    }
    default:
      return null;
  }
}
