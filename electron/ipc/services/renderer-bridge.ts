/**
 * 渲染端输出层（R5）。
 *
 * 从 `IpcRouter` 抽出的「把状态推给渲染进程」这一层。它只做三件事：
 * - 组装消息（快照 / 设置 / 错误 / 通知）
 * - 广播到所有窗口
 * - 快照变更落盘
 *
 * 为什么值得单独成型：`pushSnapshot` 被 13 个方法调用、`broadcast` 被 7 个调用，
 * 它们散布在 pane 生命周期、web 托管、状态上报各处。抽成独立对象后，
 * 后续把这些簇拆成服务时可以直接把它当作 host 传进去，而不必让每个服务
 * 反向依赖 router。
 */

import { BrowserWindow } from 'electron';
import type { Session } from '../../runtime/session';
import type { SettingsStore } from '../../runtime/settings';
import type { MainToRendererMessage } from '../../../shared/protocol';
import { IPC } from '../channels';
import { saveState } from '../../runtime/persist';
import type { PendingNotification } from '../notification-scheduler';

export class RendererBridge {
  constructor(
    private readonly session: Session,
    private readonly settings: SettingsStore,
  ) {}

  /** 广播一条消息给所有窗口。 */
  broadcast(message: MainToRendererMessage): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(message.type, message);
    }
  }

  /** 推送完整会话快照，并把快照落盘（重启后可恢复）。 */
  pushSnapshot(): void {
    const snapshot = this.session.snapshot();
    this.broadcast({
      type: IPC.STATE_SNAPSHOT,
      version: 1,
      payload: snapshot,
    });
    void saveState(snapshot);
  }

  /** 推送设置变更。 */
  pushSettings(settings: ReturnType<SettingsStore['get']>): void {
    this.broadcast({
      type: IPC.STATE_SETTINGS,
      version: 1,
      payload: settings,
    });
  }

  /** 推送一条错误（标题 key + 可选详情 key 与关联 pane/project）。 */
  pushError(
    titleKey: string,
    titleVars?: Record<string, string | number>,
    extra?: { messageKey?: string; paneId?: string; projectId?: string },
  ): void {
    this.broadcast({
      type: 'app:error',
      payload: {
        titleKey,
        titleVars,
        detailKey: extra?.messageKey,
        paneId: extra?.paneId,
        projectId: extra?.projectId,
      },
    });
  }

  /** 新窗口首次连接时推送完整快照 + 设置。 */
  pushSnapshotTo(win: BrowserWindow): void {
    win.webContents.send(IPC.STATE_SNAPSHOT, {
      type: IPC.STATE_SNAPSHOT,
      version: 1,
      payload: this.session.snapshot(),
    } satisfies MainToRendererMessage);
    win.webContents.send(IPC.STATE_SETTINGS, {
      type: IPC.STATE_SETTINGS,
      version: 1,
      payload: this.settings.get(),
    } satisfies MainToRendererMessage);
  }

  /** 把一条待投递通知推给渲染端（声音 / toast 由渲染端决定）。 */
  deliverNotification(item: PendingNotification): void {
    const pane = this.session.getPane(item.paneId);
    if (!pane) return;
    this.broadcast({
      type: IPC.AGENT_STATUS,
      payload: {
        paneId: item.paneId,
        projectId: pane.projectId,
        label: pane.label ?? item.paneId,
        status: item.status,
        ...(item.message ? { message: item.message } : {}),
      },
    });
  }
}
