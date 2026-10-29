/**
 * 项目 / pane / agent 生命周期相关的 IPC 注册。
 *
 * 从 `IpcRouter.register()` 拆出的第二组。这些通道都直接改变会话拓扑
 * （增删项目、创建/挂载/重启/关闭/聚焦 pane），是「结构性」操作。
 *
 * 依赖通过窄接口注入：本模块只转调宿主的方法，不含业务逻辑 ——
 * 业务在 `IpcRouter` 的对应方法里，这里纯粹是通道映射。
 */

import { ipcMain } from 'electron';
import type { AddProjectParams, SpawnAgentParams, SpawnWebAgentParams } from '../../../shared/state';
import { IPC } from '../channels';

/** 本模块需要宿主提供的能力。 */
export interface PaneHandlerHost {
  addProject(params: AddProjectParams): void;
  removeProject(projectId: string): void;
  toggleProject(projectId: string, collapsed: boolean): void;
  spawnAgent(params: SpawnAgentParams): void;
  spawnWebAgent(params: SpawnWebAgentParams): void;
  attachPane(paneId: string): void;
  respawnPane(paneId: string, force: boolean): void;
  closePane(paneId: string): void;
  focusPane(paneId: string): void;
  /** 高频命名子命令（pty:write / pty:resize / agent:report-session / dsh:bind-session）。 */
  handleNamed(payload: { kind: string; data: string }): void;
}

/** 注册项目与 pane 生命周期的通道。 */
export function registerPaneHandlers(host: PaneHandlerHost): void {
  ipcMain.on(IPC.ADD_PROJECT, (_event, params: AddProjectParams) => {
    host.addProject(params);
  });

  ipcMain.on(IPC.REMOVE_PROJECT, (_event, payload: { projectId: string }) => {
    host.removeProject(payload.projectId);
  });

  ipcMain.on(
    IPC.TOGGLE_PROJECT,
    (_event, payload: { projectId: string; collapsed: boolean }) => {
      host.toggleProject(payload.projectId, payload.collapsed);
    },
  );

  ipcMain.on(IPC.SPAWN_AGENT, (_event, params: SpawnAgentParams) => {
    host.spawnAgent(params);
  });

  ipcMain.on(IPC.SPAWN_WEB_AGENT, (_event, params: SpawnWebAgentParams) => {
    host.spawnWebAgent(params);
  });

  ipcMain.on(IPC.ATTACH_PANE, (_event, payload: { paneId: string }) => {
    host.attachPane(payload.paneId);
  });

  ipcMain.on(IPC.RESPAWN_PANE, (_event, payload: { paneId: string; force?: boolean }) => {
    host.respawnPane(payload.paneId, payload.force === true);
  });

  ipcMain.on(IPC.CLOSE_PANE, (_event, payload: { paneId: string }) => {
    host.closePane(payload.paneId);
  });

  ipcMain.on(IPC.FOCUS_PANE, (_event, payload: { paneId: string }) => {
    host.focusPane(payload.paneId);
  });

  ipcMain.on(IPC.NAMED, (_event, payload: { kind: string; data: string }) => {
    host.handleNamed(payload);
  });
}
