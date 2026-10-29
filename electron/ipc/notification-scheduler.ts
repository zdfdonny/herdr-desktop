/**
 * 通知调度器 —— 把「状态跳到 blocked / done」变成一次**延迟投递 + 证据复核**的通知。
 *
 * 从 `IpcRouter` 抽出的第一个协作对象。它只关心「什么时候该投递、投递前还要不要复核」，
 * 不关心 pane 生命周期、PTY、IPC 注册。
 *
 * 为什么要延迟 + 复核（而不是立即发）：
 * 1. **冷却去重**：同一 pane 的连续跳变只保留最后一条，避免一次权限提示被拆成
 *    成串的 blocked 通知；
 * 2. **投递前校验**：延后 `deliveryDelayMs` 投递，投递时按**当时**的 pane 状态复核。
 *    若状态已经变了（例如 working → idle → working 的抖动），说明这条「完成」是假象，
 *    不该响提示音。状态可能还在落定，所以按 `tickMs` 重试，超过宽限期才丢弃。
 */

/** 待投递的通知。 */
export interface PendingNotification {
  paneId: string;
  status: 'blocked' | 'done';
  message?: string;
  /** 何时可以投递。 */
  deliverAt: number;
  /** 超过这个时间仍未通过复核就丢弃（防抖动无限重试）。 */
  expiresAt: number;
}

export interface NotificationSchedulerOptions {
  /** 冷却后延迟多久投递（让状态先落定）。 */
  deliveryDelayMs: number;
  /** 复核失败的宽限期。 */
  evidenceGraceMs: number;
  /** 轮询间隔。 */
  tickMs: number;
  /** 复核：返回该 pane 当前的检测状态（null = pane 已关闭）。 */
  currentState(paneId: string): 'idle' | 'working' | 'blocked' | 'unknown' | null;
  /** 投递。 */
  deliver(item: PendingNotification): void;
}

export class NotificationScheduler {
  private pending: PendingNotification[] = [];
  private ticker: NodeJS.Timeout | null = null;

  constructor(private readonly options: NotificationSchedulerOptions) {}

  /**
   * 登记一条通知。
   *
   * 同一 pane 已有待投递通知时**替换**它（冷却去重）：用户只该被提醒一次，
   * 而且提醒的应该是最后一次跳变。
   */
  enqueue(paneId: string, status: 'blocked' | 'done', message?: string): void {
    const now = Date.now();
    this.pending = this.pending.filter((item) => item.paneId !== paneId);
    this.pending.push({
      paneId,
      status,
      ...(message ? { message } : {}),
      deliverAt: now + this.options.deliveryDelayMs,
      expiresAt: now + this.options.deliveryDelayMs + this.options.evidenceGraceMs,
    });
    this.ensureTicker();
  }

  /** 停止定时器并清空队列（应用退出 / dispose 时调用）。 */
  dispose(): void {
    this.stopTicker();
    this.pending = [];
  }

  /** 当前待投递数量（诊断用）。 */
  get size(): number {
    return this.pending.length;
  }

  private ensureTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), this.options.tickMs);
    // 不让通知定时器拖住进程退出。
    this.ticker.unref?.();
  }

  private stopTicker(): void {
    if (!this.ticker) return;
    clearInterval(this.ticker);
    this.ticker = null;
  }

  private tick(): void {
    const now = Date.now();
    const kept: PendingNotification[] = [];
    for (const item of this.pending) {
      if (item.deliverAt > now) {
        kept.push(item);
        continue;
      }
      const state = this.options.currentState(item.paneId);
      if (state === null) continue; // pane 已关闭：直接丢弃
      const expected = item.status === 'blocked' ? 'blocked' : 'idle';
      if (state !== expected) {
        /*
         * 证据不成立。若状态刚刚还在变化（尚未超过宽限期），稍后重试 ——
         * 屏幕检测的解析是分片异步的，状态可能还在落定；超过宽限期就判定为抖动丢弃。
         */
        if (now < item.expiresAt) {
          kept.push({ ...item, deliverAt: now + this.options.tickMs });
        }
        continue;
      }
      this.options.deliver(item);
    }
    this.pending = kept;
    if (this.pending.length === 0) this.stopTicker();
  }
}
