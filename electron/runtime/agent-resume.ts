/**
 * agent 会话恢复 —— 对应 herdr `src/agent_resume.rs`。
 *
 * 把「来源 + agent + 会话引用」翻译成该 agent 的恢复命令 argv。
 * 设计要点（与 herdr 一致）：
 * - 只接受官方来源（`herdr-desktop:<agent>`），自定义命令一律不参与恢复；
 * - id/path 做防御性校验，避免把会话文件/终端里的不可信内容拼进 shell。
 *
 * 重构后这里**不再持有任何 agent 表**：恢复参数、会话引用偏好、会话替换白名单、
 * 启动参数反解全部来自 `shared/agents/descriptors/`。原先是三张平行表
 * （`OFFICIAL_AGENTS` 19 条 / `resumeTail` 18 分支 switch / `SESSION_REPLACEMENT_ALLOWED`
 * 32 条），每加一个智能体要同步改三处。
 */

import { isAbsolute } from 'node:path';
import { agentIdFromSource } from '../../shared/agents/agent-id';
import { agentById } from '../../shared/agents/registry';
import type { AgentSessionRef } from './terminal/state/agent-session-ref';
import type { AgentSessionRefLike } from '../../shared/agents/spec/resume-spec';
import { normalizeSessionStartSource } from '../../shared/agents/spec/session-start-source';
import type { AgentSessionRefKind, PaneAgentSession } from '../../shared/state';

export { normalizeSessionStartSource };

export const MAX_SESSION_ID_LEN = 512;
export const MAX_SESSION_PATH_LEN = 4096;

/**
 * 恢复开关（对应 herdr `[session] resume_agents_on_restore`，默认 true）。
 *
 * 目前先做成常量，避免把设置项铺到 SettingsStore / 设置 UI / i18n；
 * 需要可配置时再把它接进 AppSettings。
 */
export const RESUME_AGENTS_ON_RESTORE = true;

export type { AgentSessionRef } from './terminal/state/agent-session-ref';

export interface AgentResumePlan {
  agent: string;
  argv: string[];
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

/**
 * 官方来源校验（对应 herdr `is_official_agent_source`）。
 *
 * 「官方」= 该智能体在本项目注册表里、且声明了官方集成（会主动上报）。
 * 重构前是一张 19 条的手写白名单，与集成表、恢复表各维护一份。
 */
export function isOfficialAgentSource(source: string, agent: string): boolean {
  if (agentIdFromSource(source) !== agent) return false;
  const descriptor = agentById(agent);
  return descriptor?.integration !== undefined;
}

/**
 * 官方集成上报的 session 引用（对应 herdr `session_ref_from_report`）。
 *
 * pi / omp 的会话既是 id 也可以是文件，上报时优先取 path（现已由 descriptor 的
 * `resume.prefersPathRef` 声明）；其余智能体只用 id。
 */
export function sessionRefFromReport(
  source: string,
  agent: string,
  agentSessionId: string | null,
  agentSessionPath: string | null,
): AgentSessionRef | null {
  if (!isOfficialAgentSource(source, agent)) return null;

  const prefersPath = agentById(agent)?.resume?.prefersPathRef === true;
  if (prefersPath) {
    return (
      (agentSessionPath != null ? sessionRefPath(agentSessionPath) : null) ??
      (agentSessionId != null ? sessionRefId(agentSessionId) : null)
    );
  }

  return agentSessionId != null ? sessionRefId(agentSessionId) : null;
}

/**
 * 上报的会话是否允许替换当前会话（对应 herdr
 * `session_report_allows_session_replacement`）。
 *
 * 白名单按智能体声明（`resume.replacementSources`）；空 source 用空串表示，
 * 对应「状态上报不带 source」的形态。
 */
export function sessionReportAllowsSessionReplacement(
  source: string,
  agent: string,
  sessionStartSource: string | null,
): boolean {
  if (!isOfficialAgentSource(source, agent)) return false;
  const allowed = agentById(agent)?.resume?.replacementSources ?? [];
  return allowed.includes(sessionStartSource ?? '');
}

/**
 * 从启动参数反推会话（对应 herdr `persisted_session_from_launch_args`）。
 *
 * 具体形态由智能体自己声明（目前只有 codex 的 `codex resume <id>`）。
 */
export function persistedSessionFromLaunchArgs(
  agent: string,
  args: string[],
): PersistedAgentSession | null {
  const descriptor = agentById(agent);
  const infer = descriptor?.resume?.fromLaunchArgs;
  if (!descriptor || !infer) return null;
  const ref = infer(args);
  if (!ref) return null;
  const sessionRef = ref.kind === 'path' ? sessionRefPath(ref.value) : sessionRefId(ref.value);
  if (!sessionRef) return null;
  return {
    source: `${'herdr-desktop'}:${descriptor.id}`,
    agent: descriptor.id,
    sessionRef,
  };
}

/** 从持久化快照恢复会话（对应 herdr `session_ref_from_snapshot`）。 */
export function sessionRefFromSnapshot(
  source: string,
  agent: string,
  kind: AgentSessionRefKind,
  value: string,
): PersistedAgentSession | null {
  if (!isOfficialAgentSource(source, agent)) return null;
  const prefersPath = agentById(agent)?.resume?.prefersPathRef === true;
  const sessionRef =
    prefersPath && kind === 'path'
      ? sessionRefPath(value)
      : kind === 'id'
        ? sessionRefId(value)
        : null;
  if (!sessionRef) return null;
  return { source, agent, sessionRef };
}


/**
 * 该 agent 能否用这个引用生成恢复命令。
 *
 * 实现就是「descriptor 里有恢复声明，且 tail 对这条引用返回非 null」。
 */
export function resumeTail(agent: string, sessionRef: AgentSessionRefLike): string[] | null {
  const descriptor = agentById(agent);
  const tail = descriptor?.resume?.tail;
  if (!tail) return null;
  return tail({ kind: sessionRef.kind, value: sessionRef.value });
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
 * 该 source/agent/sessionRef 是否能生成恢复命令（对应 herdr `plan(...).is_some()`）。
 *
 * 供终端状态机的会话所有权仲裁使用（foreground_agent_confirms_session_owner）：
 * 只有「官方来源 + 有对应恢复命令」的组合才被认定为该会话的合法持有者。
 */
export function canResume(source: string, agent: string, sessionRef: AgentSessionRef): boolean {
  if (!isOfficialAgentSource(source, agent)) return false;
  return resumeTail(agent, sessionRef) !== null;
}
