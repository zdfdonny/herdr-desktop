/**
 * 会话持久化 —— 对应 herdr `src/persist/`。
 *
 * 将 SessionState 原子落盘到 userData 目录，供重启恢复。
 * 当前为最小实现：快照 JSON + 临时文件原子替换。
 */

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { SessionState } from '../../shared/state';

const FILENAME = 'session.json';

function statePath(): string {
  return join(app.getPath('userData'), FILENAME);
}

/** 落盘串行化：避免并发写同一临时文件导致 rename ENOENT。 */
let writeChain: Promise<void> = Promise.resolve();

export async function saveState(state: SessionState): Promise<void> {
  const json = JSON.stringify(state, null, 2);

  /*
   * 串行化 + 唯一临时文件名。
   *
   * 之前所有写入共用 `${file}.tmp`：若两次 saveState 并发，
   * 后者的 rename 会因前者已移走临时文件而报 ENOENT。
   * 唯一后缀让并发写入互不干扰，链式等待保证最终落盘顺序。
   */
  const run = async (): Promise<void> => {
    const file = statePath();
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(tmp, json, 'utf8');
      await fs.rename(tmp, file);
    } catch (error) {
      // 清理可能残留的临时文件，避免污染 userData
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  writeChain = writeChain.then(run, run);
  return writeChain.catch(() => undefined);
}

export async function loadState(): Promise<SessionState | null> {
  try {
    const raw = await fs.readFile(statePath(), 'utf8');
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

/** 等待所有挂起的写入完成（退出前调用，确保状态不丢）。 */
export async function flushState(): Promise<void> {
  await writeChain.catch(() => undefined);
}
