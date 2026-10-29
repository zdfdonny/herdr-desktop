/**
 * dsh 会话 → pane 的绑定表（R3 的第一块）。
 *
 * 背景：dsh web 面板是**共享单进程**，一个 dsh 进程里可以同时开多个会话（GUI 的多个
 * pane）。插件上报状态时带的是 `sessionId`，主进程必须反查出「这个会话当前显示在哪个
 * pane 里」，才能把状态路由给正确的 pane。
 *
 * 从 `IpcRouter` 抽出：这里只有一张表和三个操作，没有任何 IPC / HTTP / PTY 依赖，
 * 是这条链路里最适合单测的部分（路由错误会表现为「A 面板的状态跳到 B 面板」，
 * 属于最难靠肉眼发现的一类 bug）。
 */

export class DshSessionBinding {
  /** sessionId → 正在显示它的 paneId 集合。 */
  private readonly bySession = new Map<string, Set<string>>();

  /**
   * 让 pane 绑定到某个会话。
   *
   * 一个 pane 同一时刻只能显示一个会话，所以先从所有会话里摘掉它，再挂到新会话下。
   * `sessionId` 为 null 表示「取消绑定」（pane 回到未绑定状态）。
   *
   * 返回 true 表示「应当请求插件重发该会话的当前状态」——
   * 切换绑定后如果不重发，pane 会停留在旧会话的最后一次状态，看起来像卡住。
   */
  bind(paneId: string, sessionId: string | null): boolean {
    this.unbindPane(paneId);
    if (!sessionId) return false;
    let set = this.bySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.bySession.set(sessionId, set);
    }
    set.add(paneId);
    return true;
  }

  /** 把 pane 从所有会话里摘掉（pane 关闭 / 重新绑定时调用）。 */
  unbindPane(paneId: string): void {
    for (const set of this.bySession.values()) set.delete(paneId);
    // 顺手清掉空集合，避免 long-lived 进程里 Map 无界增长。
    for (const [sessionId, set] of this.bySession) {
      if (set.size === 0) this.bySession.delete(sessionId);
    }
  }

  /** 某个会话当前显示在哪些 pane 里（返回副本，调用方不应改动内部结构）。 */
  panesFor(sessionId: string): string[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  /** 当前绑定条目数（诊断用）。 */
  get sessionCount(): number {
    return this.bySession.size;
  }
}
