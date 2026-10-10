/**
 * 会话拓扑管理 —— 对应 herdr `src/workspace/` + `src/app/state.rs`。
 *
 * 维护 project / pane 的结构状态；agent 的**状态**（status/seq/completion）不在此落库，
 * 而是由每个 pane 的 `TerminalState` 仲裁后在 `snapshot()` 里投影（对应 herdr 的
 * `AgentInfo` 由 terminal state + pane state 投影而来）。本模块只持有数据，
 * 不持有 PTY 句柄（由 PtyManager 持有）。
 *
 * 层级：Project（项目）→ Agent（agent pane）。
 * 必须先添加项目，才能在该项目内创建 agent。
 */

import { basename } from 'node:path';
import type {
  SessionState,
  Project,
  PaneState,
  AgentInfo,
  PaneAgentSession,
  AddProjectParams,
  SpawnAgentParams,
  SpawnWebAgentParams,
  AgentStatus,
} from '../../shared/state';
import { paneAgentStatus, isCompletionTransition } from '../../shared/agent-status';
import { TerminalState, type TerminalStateMutation } from './terminal-state';

/** Web agent 的默认展示标签。 */
const WEB_AGENT_LABEL = 'DeepSeek Harness';
/** Web agent 的识别名（与 detect-manifest 中的 agent 名一致）。 */
const WEB_AGENT_NAME = 'dsh';

let projectCounter = 0;
let paneCounter = 0;

function nextId(prefix: 'project' | 'pane'): string {
  if (prefix === 'project') {
    projectCounter += 1;
    return `project-${projectCounter}-${Date.now().toString(36)}`;
  }
  paneCounter += 1;
  return `pane-${paneCounter}-${Date.now().toString(36)}`;
}

/**
 * agent 的「身份/展示」字段（对齐 herdr 里 pane.agent / terminal.agent_name / 元数据层）。
 *
 * 状态（status/seq/completion）**不**存这里，由 TerminalState 仲裁后投影。
 * - name：检测到的显示名（检测不到时回退到启动命令，见 detectFromSnapshot）。
 * - title：终端标题。
 * - label：用户创建时指定的标签（无则 null；注意与 PaneState.label 的「命令兜底」不同）。
 * - createdAt：创建时间，用于项目内稳定排序。
 */
interface AgentMeta {
  name: string | null;
  title: string | null;
  label: string | null;
  createdAt: number;
}

export class Session {
  private projects = new Map<string, Project>();
  private panes = new Map<string, PaneState>();
  private terminals = new Map<string, TerminalState>();
  /** 未看完成标记（对应 herdr `pane.seen` 的补集；不落盘，恢复后一律视为已看）。 */
  private seen = new Map<string, boolean>();
  private meta = new Map<string, AgentMeta>();
  private nextStateChangeSeq = 0;
  private revision = 0;
  private focusedPaneId: string | null = null;

  /** 添加项目。若路径已存在则直接返回已有项目。 */
  addProject(params: AddProjectParams): Project {
    const existing = this.findProjectByPath(params.path);
    if (existing) {
      return existing;
    }
    const projectId = nextId('project');
    const project: Project = {
      projectId,
      name: params.name?.trim() || basename(params.path) || params.path,
      path: params.path,
      branch: null,
      collapsed: false,
      createdAt: Date.now(),
    };
    this.projects.set(projectId, project);
    this.bump();
    return project;
  }

  /** 移除项目及其下所有 agent。返回被移除的 paneId 列表（供调用方 kill PTY）。 */
  removeProject(projectId: string): string[] {
    const paneIds = [...this.panes.values()]
      .filter((p) => p.projectId === projectId)
      .map((p) => p.paneId);

    for (const paneId of paneIds) {
      this.panes.delete(paneId);
      this.terminals.delete(paneId);
      this.seen.delete(paneId);
      this.meta.delete(paneId);
    }
    this.projects.delete(projectId);

    if (this.focusedPaneId && paneIds.includes(this.focusedPaneId)) {
      this.setFocus(this.panes.keys().next().value ?? null);
    }
    this.bump();
    return paneIds;
  }

  toggleProject(projectId: string, collapsed: boolean): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    project.collapsed = collapsed;
    this.bump();
  }

  /** 更新项目的 git 分支信息（异步探测结果回填）。 */
  setProjectBranch(projectId: string, branch: string | null): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    if (project.branch === branch) return;
    project.branch = branch;
    this.bump();
  }

  /**
   * 在指定项目内创建 agent。
   * 项目不存在时抛错 —— 强制"先添加项目，再创建 agent"的流程。
   */
  createAgent(params: SpawnAgentParams): PaneState {
    const project = this.projects.get(params.projectId);
    if (!project) {
      throw new Error(`project ${params.projectId} does not exist`);
    }

    const paneId = nextId('pane');
    const pane: PaneState = {
      paneId,
      projectId: project.projectId,
      label: params.label ?? params.command,
      cwd: params.cwd ?? project.path,
      focused: true,
      command: params.command,
      args: params.args ?? [],
      running: true,
      kind: 'pty',
      agentSession: null,
    };
    this.panes.set(paneId, pane);
    this.terminals.set(paneId, new TerminalState(paneId));
    this.seen.set(paneId, true);
    this.meta.set(paneId, {
      name: null,
      title: null,
      label: params.label ?? null,
      createdAt: Date.now(),
    });

    this.setFocus(paneId);
    project.collapsed = false;
    this.bump();
    return pane;
  }

  /**
   * 在指定项目内创建 DeepSeek Harness Web agent。
   *
   * 与 createAgent（PTY）不同：web agent 没有终端可检测，
   * 因此 TerminalState 的 fallback 直接置 idle；启动命令固定为 `dsh web` 供恢复重放。
   * 项目不存在时抛错（与 createAgent 一致）。
   */
  createWebAgent(params: SpawnWebAgentParams): PaneState {
    const project = this.projects.get(params.projectId);
    if (!project) {
      throw new Error(`project ${params.projectId} does not exist`);
    }

    const paneId = nextId('pane');
    const pane: PaneState = {
      paneId,
      projectId: project.projectId,
      label: params.label ?? WEB_AGENT_LABEL,
      cwd: project.path,
      focused: true,
      command: 'dsh web',
      args: [],
      running: true,
      kind: 'web',
      webUrl: null,
      agentSession: null,
    };
    this.panes.set(paneId, pane);
    const terminal = new TerminalState(paneId);
    // web pane 无终端检测，fallback 直接 idle（保持既有「web agent 常驻 idle」语义）。
    terminal.fallbackState = 'idle';
    terminal.state = 'idle';
    this.terminals.set(paneId, terminal);
    this.seen.set(paneId, true);
    this.meta.set(paneId, {
      name: WEB_AGENT_NAME,
      title: null,
      label: params.label ?? null,
      createdAt: Date.now(),
    });

    this.setFocus(paneId);
    project.collapsed = false;
    this.bump();
    return pane;
  }

  /** 更新 web pane 的干净地址（就绪后回填）。 */
  setPaneWebUrl(paneId: string, webUrl: string | null): void {
    const pane = this.panes.get(paneId);
    if (!pane || pane.kind !== 'web') return;
    if (pane.webUrl === webUrl) return;
    pane.webUrl = webUrl;
    this.bump();
  }

  /** 记录 web pane 实际监听的端口（就绪后回填，供下次重启复用稳定 origin）。 */
  setPanePort(paneId: string, port: number | null): void {
    const pane = this.panes.get(paneId);
    if (!pane || pane.kind !== 'web') return;
    if (pane.port === port) return;
    pane.port = port;
    this.bump();
  }

  /**
   * 直接持久化 pane 的 agent 会话引用（对应 herdr `set_persisted_agent_session`）。
   *
   * 用于「非 hook 权威」的会话来源：从启动参数反推（如 `codex resume <id>`）或
   * 终端输出兜底识别。幂等落库：相同引用不重复触发结构变更。
   */
  setPaneAgentSession(paneId: string, session: PaneAgentSession | null): void {
    const terminal = this.terminals.get(paneId);
    if (!terminal) return;
    const current = terminal.currentSessionForPersistence();
    const same =
      current === null && session === null
        ? true
        : current !== null &&
          session !== null &&
          current.source === session.source &&
          current.agent === session.agent &&
          current.kind === session.kind &&
          current.value === session.value;
    if (same) return;
    terminal.persistedAgentSession = session
      ? {
          source: session.source,
          agent: session.agent,
          sessionRef: { kind: session.kind, value: session.value },
        }
      : null;
    this.bump();
  }

  /** 读取单个 pane（不存在返回 undefined）。 */
  getPane(paneId: string): PaneState | undefined {
    return this.panes.get(paneId);
  }

  /** 读取 pane 的终端状态机（不存在返回 undefined）。 */
  getTerminal(paneId: string): TerminalState | undefined {
    return this.terminals.get(paneId);
  }

  /** 该 pane 是否当前聚焦（用于 done/seen 判定）。 */
  isFocusedPane(paneId: string): boolean {
    return this.focusedPaneId === paneId;
  }

  /**
   * 更新 agent 的检测展示字段（name/title，对应 herdr 元数据/presentation 层）。
   *
   * 状态不在这里改：状态一律经 TerminalState 仲裁后在 snapshot 投影。
   */
  updateAgentPresentation(paneId: string, name: string | null, title: string | null): void {
    const meta = this.meta.get(paneId);
    if (!meta) return;
    if (meta.name === name && meta.title === title) return;
    meta.name = name;
    meta.title = title;
    this.bump();
  }

  closePane(paneId: string): void {
    const closing = this.panes.get(paneId);
    this.panes.delete(paneId);
    this.terminals.delete(paneId);
    this.seen.delete(paneId);
    this.meta.delete(paneId);
    if (this.focusedPaneId === paneId) {
      /*
       * 焦点转移按「项目」进行，而不是随手交给 Map 里第一个 pane：
       * 关闭当前焦点 agent/tab 后，优先聚焦同项目剩余的第一个 pane
       *（即该项目下最早创建、仍在的标签）；同项目没有剩余 pane 时清空焦点，
       * 让内容区显示空状态，避免跳到其它项目。
       */
      const nextId = closing
        ? [...this.panes.values()].find((p) => p.projectId === closing.projectId)?.paneId ?? null
        : null;
      this.setFocus(nextId);
    }
    this.bump();
  }

  /**
   * 从持久化快照恢复会话（应用启动时调用）。
   *
   * 恢复的是**元数据**：项目、pane、agent 的结构关系与身份字段（name/label/title/createdAt）。
   * PTY 进程不可能跨重启存活，因此所有 pane 的 running 一律置为 false，
   * agent 状态归为 idle（TerminalState 新建、fallback unknown；web pane fallback idle）。
   *
   * **不恢复聚焦**：启动时不选中任何 agent，主区域显示初始空状态。
   *
   * 防御性归一化：旧版本 session.json 缺 command 字段的 pane 无法重启，直接丢弃。
   */
  restore(saved: SessionState): void {
    // 项目：全部恢复（按路径去重，抵御手改过的文件）
    for (const project of saved.projects ?? []) {
      if (!project?.projectId || !project.path) continue;
      if (this.findProjectByPath(project.path)) continue;
      this.projects.set(project.projectId, {
        ...project,
        branch: project.branch ?? null,
        collapsed: Boolean(project.collapsed),
        createdAt: project.createdAt ?? Date.now(),
      });
    }

    // pane + terminal + seen：只恢复带 command 的（可重启）；running 一律 false
    for (const pane of saved.panes ?? []) {
      if (!pane?.paneId || !pane.command) continue;
      if (!this.projects.has(pane.projectId)) continue; // 孤儿 pane，丢弃
      this.panes.set(pane.paneId, {
        ...pane,
        args: pane.args ?? [],
        running: false,
        restartSeq: 0,
        focused: false,
        kind: pane.kind === 'web' ? 'web' : 'pty',
        webUrl: typeof pane.webUrl === 'string' ? pane.webUrl : null,
      });
      this.seen.set(pane.paneId, true);

      const terminal = new TerminalState(pane.paneId);
      if (pane.kind === 'web') {
        terminal.fallbackState = 'idle';
        terminal.state = 'idle';
      }
      // 恢复持久化的会话引用（来源合法性在生成恢复计划时再判）
      const session = normalizePaneAgentSession(pane.agentSession);
      if (session) {
        terminal.persistedAgentSession = {
          source: session.source,
          agent: session.agent,
          sessionRef: { kind: session.kind, value: session.value },
        };
      }
      this.terminals.set(pane.paneId, terminal);
    }

    // agent 身份/展示字段：从旧快照的 agents 里读回（status 已过时，丢弃）
    for (const agent of saved.agents ?? []) {
      if (!agent?.paneId || !this.panes.has(agent.paneId)) continue;
      this.meta.set(agent.paneId, {
        name: typeof agent.name === 'string' ? agent.name : null,
        title: typeof agent.title === 'string' ? agent.title : null,
        label: typeof agent.label === 'string' ? agent.label : null,
        createdAt: typeof agent.createdAt === 'number' ? agent.createdAt : Date.now(),
      });
    }

    // 兜底：pane 存在但旧快照缺 agents 条目时，补一份空 meta
    for (const pane of this.panes.values()) {
      if (this.meta.has(pane.paneId)) continue;
      this.meta.set(pane.paneId, {
        name: null,
        title: null,
        label: pane.label ?? null,
        createdAt: Date.now(),
      });
    }

    // 聚焦保持 null：启动时不选中任何 agent（见方法注释）
    this.focusedPaneId = null;

    this.bump();
  }

  /** 更新 pane 的运行标记（重启流程使用）。 */
  setPaneRunning(paneId: string, running: boolean): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    pane.running = running;
    this.bump();
  }

  /** 递增 pane 的重启计数（运行中强制重启使用）。 */
  bumpPaneRestart(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    pane.restartSeq = (pane.restartSeq ?? 0) + 1;
    this.bump();
  }

  /**
   * 统一设置焦点：同时维护 focusedPaneId 与每个 pane 的 focused 标记。
   */
  private setFocus(paneId: string | null): void {
    this.focusedPaneId = paneId;
    for (const p of this.panes.values()) {
      p.focused = p.paneId === paneId;
    }
  }

  focusPane(paneId: string): void {
    if (!this.panes.has(paneId)) return;
    this.setFocus(paneId);
    // 聚焦即「已看」：done 投影立即回落 idle（等价 herdr 里 seen=true）。
    this.seen.set(paneId, true);
    this.bump();
  }

  /**
   * 应用一次 TerminalState 变更（对应 herdr `actions.rs` 的 completion_reset /
   * seq bump / apply_pane_state_change 三段编排）。
   *
   * 返回投影后的状态跳变（from/to），供调用方决定是否通知；无可见变化返回 null。
   */
  applyStateChange(
    paneId: string,
    mutation: TerminalStateMutation,
    forceSuppressCompletion: boolean,
  ): { from: AgentStatus; to: AgentStatus } | null {
    const terminal = this.terminals.get(paneId);
    if (!terminal) return null;
    const change = mutation.effectiveStateChange;

    // completion reset：会话引用变化或 agent 身份变化时，上一次完成不再有效。
    const completionReset =
      mutation.sessionRefChanged ||
      (change !== null && change.previousAgentLabel !== change.agentLabel);
    if (completionReset) {
      terminal.lastAgentCompletionSeq = null;
      // 对应 herdr completion_reset：旧的 done（未看）作废，重置为已看。
      this.seen.set(paneId, true);
    }

    if (change === null) {
      return null;
    }

    const previousSeen = this.seen.get(paneId) ?? true;
    const suppressAcquisitionCompletion = terminal.finishAgentProcessAcquisition();
    const suppressCompletion =
      forceSuppressCompletion ||
      (change.state === 'idle' && suppressAcquisitionCompletion);

    if (change.previousState !== change.state) {
      this.nextStateChangeSeq += 1;
      terminal.lastAgentStateChangeSeq = this.nextStateChangeSeq;
      terminal.lastAgentCompletionSeq =
        !suppressCompletion && isCompletionTransition(change.previousState, change.state)
          ? this.nextStateChangeSeq
          : null;
    }

    // seen 转移（对应 herdr apply_pane_state_change）：
    // 非 idle → seen=true；完成跳变 → seen = 是否聚焦（desktop 无 tab/终端焦点，
    // 用 focusedPaneId 近似 herdr 的 active_tab && outer_terminal_focus）。
    const focused = this.focusedPaneId === paneId;
    if (change.state !== 'idle') {
      this.seen.set(paneId, true);
    } else if (!suppressCompletion && isCompletionTransition(change.previousState, change.state)) {
      // 聚焦 = 已看（idle）；后台 = 未看（done）。对应 herdr 的
      // pane.seen = suppress_active_tab_notifications。
      this.seen.set(paneId, focused);
    }
    const seen = this.seen.get(paneId) ?? true;

    const from = paneAgentStatus(change.previousState, previousSeen);
    const to = paneAgentStatus(terminal.state, seen);
    if (from === to) return null;
    return { from, to };
  }

  snapshot(): SessionState {
    const panes = [...this.panes.values()].map((pane) => ({
      ...pane,
      agentSession: this.projectAgentSession(pane.paneId),
    }));
    const agents = [...this.panes.values()].map((pane) => this.projectAgent(pane));
    return {
      projects: [...this.projects.values()].sort((a, b) => a.createdAt - b.createdAt),
      panes,
      agents,
      focusedPaneId: this.focusedPaneId,
      revision: this.revision,
    };
  }

  private projectAgent(pane: PaneState): AgentInfo {
    const terminal = this.terminals.get(pane.paneId);
    const meta = this.meta.get(pane.paneId);
    const seen = this.seen.get(pane.paneId) ?? true;
    const state = terminal ? terminal.state : 'unknown';
    return {
      paneId: pane.paneId,
      projectId: pane.projectId,
      name: meta?.name ?? null,
      label: meta?.label ?? null,
      title: meta?.title ?? null,
      status: paneAgentStatus(state, seen),
      stateChangeSeq: terminal?.lastAgentStateChangeSeq ?? 0,
      completionSeq: terminal?.lastAgentCompletionSeq ?? null,
      focused: pane.focused,
      createdAt: meta?.createdAt ?? Date.now(),
      launchPending: terminal?.managedAgentLaunchPending() ?? false,
      interactiveReady: terminal?.managedAgentInteractiveReady() ?? false,
      screenDetectionSkipped: terminal?.fullLifecycleHookAuthorityActive() ?? false,
    };
  }

  private projectAgentSession(paneId: string): PaneAgentSession | null {
    const terminal = this.terminals.get(paneId);
    if (!terminal) return null;
    const session = terminal.currentSessionForPersistence();
    return session
      ? { source: session.source, agent: session.agent, kind: session.kind, value: session.value }
      : null;
  }

  private findProjectByPath(path: string): Project | undefined {
    const normalized = path.replace(/[\\/]+$/, '').toLowerCase();
    for (const project of this.projects.values()) {
      if (project.path.replace(/[\\/]+$/, '').toLowerCase() === normalized) {
        return project;
      }
    }
    return undefined;
  }

  private bump(): void {
    this.revision++;
  }
}

/**
 * 防御性归一化持久化的 agent 会话引用。
 *
 * 旧版本 / 手改过的 session.json 可能缺字段或 kind 非法；
 * 恢复时只保留结构合法的引用，来源合法性留到恢复计划生成时再判。
 */
function normalizePaneAgentSession(
  session: PaneAgentSession | null | undefined,
): PaneAgentSession | null {
  if (!session) return null;
  if (session.kind !== 'id' && session.kind !== 'path') return null;
  if (typeof session.value !== 'string' || session.value.length === 0) return null;
  return {
    source: typeof session.source === 'string' ? session.source : '',
    agent: typeof session.agent === 'string' ? session.agent : '',
    kind: session.kind,
    value: session.value,
  };
}
