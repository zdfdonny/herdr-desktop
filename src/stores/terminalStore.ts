/**
 * terminal store —— 终端数据流（高频）。
 *
 * 关键设计：**这里不是渲染通道，只是回放缓冲**。
 *
 * 早期实现把 store 当成 PTY 数据的传输通道，导致每来一个数据块
 * buffers 就变化 → TerminalPane 的 effect 触发 → `reset()` + 全量重放，
 * 屏幕被反复清空重建（实测每秒数千次 DOM 变动，肉眼可见闪烁）。
 *
 * 现在的职责划分：
 * - PTY 数据 → 直接写入 xterm 实例（见 terminalBus），不经过 React 渲染；
 * - store 仅保存最近一段文本，供新建/重挂载的终端一次性回放。
 *
 * 因此 `append` 刻意不触发订阅者重渲染，回放只在挂载时发生一次。
 */

import { create } from 'zustand';

/** 每个 pane 保留的回放缓冲上限。 */
const MAX_BUFFER = 200_000;

/**
 * 终端写入总线 —— 把 PTY 数据直接送给对应的 xterm 实例。
 *
 * 绕过 React 与 zustand 订阅，避免高频数据触发重渲染。
 */
class TerminalBus {
  private writers = new Map<string, (data: string) => void>();
  private pending = new Map<string, string[]>();

  /** 注册某个 pane 的写入器（终端挂载时调用）。 */
  register(paneId: string, write: (data: string) => void): void {
    this.writers.set(paneId, write);
    // 补发注册前到达的数据，避免首屏丢字
    const queued = this.pending.get(paneId);
    if (queued && queued.length > 0) {
      for (const chunk of queued) {
        write(chunk);
      }
      this.pending.delete(paneId);
    }
  }

  /** 注销写入器（终端卸载时调用）。 */
  unregister(paneId: string): void {
    this.writers.delete(paneId);
  }

  /**
   * 投递 PTY 数据。
   *
   * 有活跃终端时直接写入；否则暂存，等终端挂载后补发。
   */
  emit(paneId: string, data: string): void {
    const write = this.writers.get(paneId);
    if (write) {
      write(data);
      return;
    }
    const queued = this.pending.get(paneId) ?? [];
    queued.push(data);
    // 未挂载期间的暂存也需要上限，避免内存无界增长
    let total = 0;
    for (let i = queued.length - 1; i >= 0; i -= 1) {
      total += queued[i].length;
      if (total > MAX_BUFFER) {
        queued.splice(0, i);
        break;
      }
    }
    this.pending.set(paneId, queued);
  }

  /** pane 关闭时清理。 */
  dispose(paneId: string): void {
    this.writers.delete(paneId);
    this.pending.delete(paneId);
  }
}

export const terminalBus = new TerminalBus();

interface TerminalStore {
  /** paneId -> 回放缓冲（仅在终端挂载时读取一次）。 */
  buffers: Record<string, string>;
  /** 追加到回放缓冲。**刻意不触发订阅者重渲染**。 */
  append: (paneId: string, data: string) => void;
  /** 清空某个 pane 的缓冲（进程退出时调用）。 */
  reset: (paneId: string) => void;
  /** 取回放缓冲（非响应式读取）。 */
  getBuffer: (paneId: string) => string;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  buffers: {},

  /*
   * 注意：这里直接改内部对象并 **不** 调用 set()。
   *
   * 高频 PTY 数据若走 set()，会让任何订阅 buffers 的组件每块数据都重渲染，
   * 这正是闪烁的根因。缓冲只用于终端挂载时的一次性回放，无需响应式。
   */
  append: (paneId, data) => {
    const state = get();
    const next = ((state.buffers[paneId] ?? '') + data).slice(-MAX_BUFFER);
    state.buffers[paneId] = next;
  },

  reset: (paneId) => {
    set((state) => {
      const buffers = { ...state.buffers };
      delete buffers[paneId];
      return { buffers };
    });
    terminalBus.dispose(paneId);
  },

  getBuffer: (paneId) => get().buffers[paneId] ?? '',
}));
