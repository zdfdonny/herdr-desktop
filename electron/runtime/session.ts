/**
 * 会话拓扑管理 —— 对应 herdr `src/workspace/` + `src/app/state.rs`。
 *
 * 维护 project / pane / agent 的结构状态，对外产出纯 SessionState 快照。
 * 本模块只持有数据（SessionState），不持有 PTY 句柄（由 PtyManager 持有）。
 *
 * 层级：Project（项目）→ Agent（agent pane）。
 * 必须先添加项目，才能在该项目内创建 agent。
 */

import { basename } from 'node:path';
import type {
  SessionState,
  Project,
  PaneState,
  AgentState,
  PaneAgentSession,
  AddProjectParams,
  SpawnAgentParams,
  SpawnWebAgentParams,
} from '../../shared/state';

/** Web agent 的默认展示标签。 */
const WEB_AGENT_LABEL = 'DeepSeek Harness';
/** Web agent 的识别名（与 detect-manifest 中的 agent 名一致）。 */
const WEB_AGENT_NAME = 'dsh';

let projectCounter = 0;
let paneCounter = 0;
let stateChangeCounter = 0;

function nextId(prefix: string): string {
  const n = counterFor(prefix);
  return `${prefix}-${n}-${Date.now().toString(36)}`;
}

function counterFor(prefix: string): number {
  switch (prefix) {
    case 'project':
      projectCounter += 1;
      return projectCounter;
    case 'pane':
      paneCounter += 1;
      return paneCounter;
    default:
      stateChangeCounter += 1;
      return stateChangeCounter;
  }
}

export class Session {
  private projects = new Map<string, Project>();
  private panes = new Map<string, PaneState>();
  private agents = new Map<string, AgentState>();
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
      this.agents.delete(paneId);
    }
    this.projects.delete(projectId);

    if (this.focusedPaneId && paneIds.includes(this.focusedPaneId)) {
      this.focusedPaneId = this.panes.keys().next().value ?? null;
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
      // 记录启动命令，重启应用后可据此一键恢复
      command: params.command,
      args: params.args ?? [],
      running: true,
      kind: 'pty',
      agentSession: null,
    };
    this.panes.set(paneId, pane);

    const agent: AgentState = {
      paneId,
      projectId: project.projectId,
      name: null,
      label: params.label ?? null,
      title: null,
      status: 'unknown',
      stateChangeSeq: 0,
      focused: true,
    };
    this.agents.set(paneId, agent);

    // 取消其他 pane 的 focused
    for (const p of this.panes.values()) {
      if (p.paneId !== paneId) {
        p.focused = false;
        const a = this.agents.get(p.paneId);
        if (a) a.focused = false;
      }
    }
    this.focusedPaneId = paneId;
    // 新建 agent 时自动展开所属项目分组
    project.collapsed = false;
    this.bump();
    return pane;
  }

  /**
   * 在指定项目内创建 DeepSeek Harness Web agent。
   *
   * 与 createAgent（PTY）不同：web agent 没有终端可检测，
   * 直接置 name='dsh'、status='idle'；启动命令固定为 `dsh web` 供恢复重放。
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

    const agent: AgentState = {
      paneId,
      projectId: project.projectId,
      name: WEB_AGENT_NAME,
      label: params.label ?? null,
      title: null,
      status: 'idle',
      stateChangeSeq: 0,
      focused: true,
    };
    this.agents.set(paneId, agent);

    // 取消其他 pane 的 focused
    for (const p of this.panes.values()) {
      if (p.paneId !== paneId) {
        p.focused = false;
        const a = this.agents.get(p.paneId);
        if (a) a.focused = false;
      }
    }
    this.focusedPaneId = paneId;
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

  /**
   * 记录 pane 的 agent 会话引用（官方集成上报，对应 herdr 的 hook 上报）。
   *
   * 调用方（router）负责校验来源与会话值，这里只做幂等落库：
   * 相同引用不重复触发结构变更，避免上报洪峰反复刷快照。
   */
  setPaneAgentSession(paneId: string, session: PaneAgentSession | null): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    const current = pane.agentSession ?? null;
    if (current === session) return;
    if (
      current &&
      session &&
      current.source === session.source &&
      current.agent === session.agent &&
      current.kind === session.kind &&
      current.value === session.value
    ) {
      return;
    }
    pane.agentSession = session;
    this.bump();
  }

  /** 读取单个 pane（不存在返回 undefined）。 */
  getPane(paneId: string): PaneState | undefined {
    return this.panes.get(paneId);
  }

  closePane(paneId: string): void {
    this.panes.delete(paneId);
    this.agents.delete(paneId);
    if (this.focusedPaneId === paneId) {
      this.focusedPaneId = this.panes.keys().next().value ?? null;
    }
    this.bump();
  }

  /**
   * 从持久化快照恢复会话（应用启动时调用）。
   *
   * 恢复的是**元数据**：项目、pane、agent 的结构关系。
   * PTY 进程不可能跨重启存活，因此所有 pane 的 running 一律置为 false，
   * agent 状态归为 idle（保留 label/title 供辨识）。
   *
   * **不恢复聚焦**：启动时不选中任何 agent，主区域显示初始空状态；
   * 用户点击侧栏中的 agent 行才会选中并自动恢复（见 router.focusPane）。
   * 持久化文件里的 focusedPaneId 因此成为被忽略的遗留字段。
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

    // pane：只恢复带 command 的（可重启）；running 一律 false
    for (const pane of saved.panes ?? []) {
      if (!pane?.paneId || !pane.command) continue;
      if (!this.projects.has(pane.projectId)) continue; // 孤儿 pane，丢弃
      this.panes.set(pane.paneId, {
        ...pane,
        args: pane.args ?? [],
        running: false,
        /*
         * 重启计数按「本次会话内」计，恢复时归零。
         * 不归零也不会出错（渲染端只比较前后值是否变化），
         * 但归零让语义保持单纯：它数的是这次运行期间重启了几次。
         */
        restartSeq: 0,
        focused: false,
        // 旧版本快照缺 kind/webUrl：按 PTY 处理，webUrl 归 null
        kind: pane.kind === 'web' ? 'web' : 'pty',
        webUrl: typeof pane.webUrl === 'string' ? pane.webUrl : null,
        agentSession: normalizePaneAgentSession(pane.agentSession),
      });
    }

    // agent：跟随 pane 恢复；状态归 idle（快照里的状态已过时）
    for (const agent of saved.agents ?? []) {
      if (!agent?.paneId || !this.panes.has(agent.paneId)) continue;
      this.agents.set(agent.paneId, {
        ...agent,
        status: 'idle',
        focused: false,
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

  /**
   * 递增 pane 的重启计数（运行中强制重启使用）。
   *
   * 渲染端据此重建终端并重新走两阶段启动的 attach 步骤——
   * 见 shared/state.ts 中 restartSeq 的说明。
   */
  bumpPaneRestart(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    pane.restartSeq = (pane.restartSeq ?? 0) + 1;
    this.bump();
  }

  focusPane(paneId: string): void {
    if (!this.panes.has(paneId)) return;
    for (const p of this.panes.values()) {
      p.focused = p.paneId === paneId;
      const a = this.agents.get(p.paneId);
      if (a) a.focused = p.paneId === paneId;
    }
    this.focusedPaneId = paneId;
    this.bump();
  }

  /**
   * 更新 agent 检测结果。
   *
   * 状态发生变化时返回 `{ from, to }`，供调用方判断是否需要通知；
   * 无变化返回 null。
   */
  updateAgent(
    paneId: string,
    patch: { name: string | null; title: string | null; status: AgentState['status'] },
  ): { from: AgentState['status']; to: AgentState['status'] } | null {
    const agent = this.agents.get(paneId);
    if (!agent) return null;
    const changed =
      agent.name !== patch.name ||
      agent.title !== patch.title ||
      agent.status !== patch.status;
    if (!changed) return null;
    const from = agent.status;
    agent.name = patch.name;
    agent.title = patch.title;
    agent.status = patch.status;
    agent.stateChangeSeq = ++stateChangeCounter;
    this.bump();
    return { from, to: patch.status };
  }

  snapshot(): SessionState {
    return {
      projects: [...this.projects.values()].sort((a, b) => a.createdAt - b.createdAt),
      panes: [...this.panes.values()],
      agents: [...this.agents.values()],
      focusedPaneId: this.focusedPaneId,
      revision: this.revision,
    };
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
