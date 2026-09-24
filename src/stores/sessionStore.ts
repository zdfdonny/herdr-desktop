/**
 * sessions store —— 结构状态的投影（低频）。
 *
 * 保存 Main 端 SessionState 快照，Renderer 不做本地权威状态，
 * 所有结构变化都来自 Main 推送的 snapshot。
 */

import { create } from 'zustand';
import type { SessionState, Project, AgentState } from '@shared/state';

interface SessionStore {
  state: SessionState;
  setState: (state: SessionState) => void;
}

const emptyState: SessionState = {
  projects: [],
  panes: [],
  agents: [],
  focusedPaneId: null,
  revision: 0,
};

export const useSessionStore = create<SessionStore>((set) => ({
  state: emptyState,
  setState: (state) => set({ state }),
}));

/** 便捷选择器：聚焦的 pane id。 */
export function useFocusedPaneId(): string | null {
  return useSessionStore((s) => s.state.focusedPaneId);
}

/** 按项目分组的 agent 列表。 */
export interface ProjectGroup {
  project: Project;
  agents: ProjectGroupAgent[];
  /** 该项目下处于 blocked 状态的 agent 数（用于徽标）。 */
  blockedCount: number;
  /** 该项目下处于 working 状态的 agent 数。 */
  workingCount: number;
}

/**
 * 侧栏 agent 行的视图模型：AgentState + 来自 pane 的运行标记。
 *
 * running=false 表示这是恢复出的（进程已死的）pane，行会显示停止态。
 */
export interface ProjectGroupAgent extends AgentState {
  running: boolean;
}

export function useProjectGroups(): ProjectGroup[] {
  const state = useSessionStore((s) => s.state);
  return state.projects.map((project) => {
    const agents: ProjectGroupAgent[] = state.agents
      .filter((a) => a.projectId === project.projectId)
      .map((a) => ({
        ...a,
        // 旧快照可能缺 running 字段，按运行中处理（向后兼容）
        running: state.panes.find((p) => p.paneId === a.paneId)?.running ?? true,
      }));
    return {
      project,
      agents,
      blockedCount: agents.filter((a) => a.status === 'blocked').length,
      workingCount: agents.filter((a) => a.status === 'working').length,
    };
  });
}
