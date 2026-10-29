/**
 * 「正在走重启恢复流程」的 pane 集合。
 *
 * 从 `IpcRouter` 抽出的共享状态。web 托管与 pane 生命周期两个服务都要用它，
 * 所以单独成型、由 router 持有并注入，避免两处各存一份导致判断不一致。
 *
 * 语义区别很关键：**重启失败时保留 pane 条目**（只是回到停止态），
 * 而新建失败要回滚删除。两者的分界线就是「这个 paneId 在不在这个集合里」。
 */

export class RevivingPanes {
  private readonly ids = new Set<string>();

  /** 标记该 pane 进入恢复流程。 */
  add(paneId: string): void {
    this.ids.add(paneId);
  }

  /** 该 pane 是否正在恢复。 */
  has(paneId: string): boolean {
    return this.ids.has(paneId);
  }

  /** 恢复成功或放弃，清掉标记。 */
  delete(paneId: string): void {
    this.ids.delete(paneId);
  }

  /** 当前恢复中的 pane 数量（诊断用）。 */
  get size(): number {
    return this.ids.size;
  }
}
