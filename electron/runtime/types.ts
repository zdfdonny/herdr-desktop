/**
 * Runtime 内部类型 —— 仅存在于 Main 进程，不序列化。
 *
 * 对应 herdr 的 "State 与 Runtime 分离"：
 * PtyRuntime 持有 node-pty 句柄与数据流，属于运行时侧。
 */

import type { IPty } from 'node-pty';

export interface PtyRuntime {
  paneId: string;
  pty: IPty;
  /** 终端输出累积快照，用于 agent 检测（不渲染）。 */
  buffer: string;
  disposed: boolean;
}

/** PTY 数据事件回调。 */
export interface PtyCallbacks {
  onData: (paneId: string, data: string) => void;
  onExit: (paneId: string, exitCode: number, signal: number | undefined) => void;
}
