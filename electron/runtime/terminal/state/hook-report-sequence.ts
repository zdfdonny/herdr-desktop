/**
 * hook 上报的序号水位 —— 每个 pane、每个上报来源各一条。
 *
 * 从 `TerminalState` 抽出的第一个协作对象：它不依赖状态机的任何其它字段，
 * 只维护「某来源已见过的最大 seq」，据此判断一条上报是新是旧。
 *
 * 为什么需要水位：hook 上报走 HTTP，异步且可能乱序（claude 的 PostToolUse 是 async、
 * Stop 是同步）。若不过滤，一条迟到的 working 会把已完成的状态顶回 working，
 * 完成提示音就丢了。
 */

export class HookReportSequence {
  /** 来源 → 已接受的最大 seq。 */
  private readonly watermarks = new Map<string, number>();

  /**
   * 对应 herdr `hook_report_is_newer`。
   *
   * - 带 seq：必须严格大于该来源已知水位（首条总是通过）；
   * - 不带 seq（null）：**只在没有水位时**通过 —— 一旦该来源有过带 seq 的上报，
   *   后续的无 seq 上报就不可信（可能是乱序的旧消息），一律拒绝。
   */
  isNewer(source: string, seq: number | null): boolean {
    const last = this.watermarks.get(source);
    if (seq !== null) {
      return last === undefined || seq > last;
    }
    return last === undefined;
  }

  /**
   * 接受一条上报并推进水位；被拒时返回 false 且不改变任何状态。
   */
  accept(source: string, seq: number | null): boolean {
    if (!this.isNewer(source, seq)) return false;
    if (seq !== null) {
      this.watermarks.set(source, seq);
    }
    return true;
  }

  /**
   * 给一条上报补一个严格递增的 seq（调用方拿不到可移植时间戳时使用）。
   *
   * 不能用裸 `Date.now()`：同一毫秒内的两条上报会取到相同值，后一条被
   * `isNewer` 丢掉 —— 若丢的是 Stop 的 idle，完成提示音就再也不会响。
   * 因此取 `max(now, 本 pane 水位最大值 + 1)`：严格单调且不落后于墙上时间。
   *
   * 水位是 per-pane、跨来源的单调计数器，所以这里扫的是该 pane 内所有来源的水位。
   * **只读不写** —— 真正推进水位在 `accept` 里。
   */
  next(now: number = Date.now()): number {
    let max = now;
    for (const last of this.watermarks.values()) {
      if (last >= max) max = last + 1;
    }
    return max;
  }

  /** 某来源的当前水位（无则 undefined）。 */
  watermark(source: string): number | undefined {
    return this.watermarks.get(source);
  }

  /** 全部水位值（用于计算下一个严格递增的 seq）。 */
  allWatermarks(): number[] {
    return [...this.watermarks.values()];
  }

  /** 直接设定水位（重放 pending 上报等场景使用）。 */
  set(source: string, seq: number): void {
    this.watermarks.set(source, seq);
  }

  /** 丢弃某来源的水位（会话切换 / 进程退出后允许从新会话重新计数）。 */
  reset(source: string): void {
    this.watermarks.delete(source);
  }

  /** 全部已知来源（用于清理陈腐会话）。 */
  sources(): string[] {
    return [...this.watermarks.keys()];
  }
}
