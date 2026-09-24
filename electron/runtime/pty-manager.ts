/**
 * PTY 生命周期管理器 —— 对应 herdr `src/pty/`。
 *
 * 用 node-pty（Windows ConPTY）spawn agent 子进程，管理 resize / write / kill。
 * 终端输出累积到 buffer 供 agent 检测使用，同时通过 onData 回调推送给 Renderer。
 *
 * spawn 不抛异常：命令不存在等失败以 SpawnResult 返回，由调用方转成用户可见的错误，
 * 避免未捕获异常冒泡成 Electron 主进程崩溃对话框。
 */

import * as pty from 'node-pty';
import type { PtyRuntime, PtyCallbacks } from './types';
import type { SpawnAgentParams } from '../../shared/state';
import { resolveExecutable, resolveDefaultShell, isWindowsBatchFile, isWindows } from '../platform';

const MAX_BUFFER_CHARS = 200_000;

/** spawn 结果：成功带 runtime，失败带可展示的错误。 */
export type SpawnResult =
  | { ok: true; runtime: PtyRuntime }
  | { ok: false; error: string; reason: 'not-found' | 'spawn-failed' | 'duplicate' };

export class PtyManager {
  private runtimes = new Map<string, PtyRuntime>();
  private callbacks: PtyCallbacks;

  constructor(callbacks: PtyCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * spawn 一个 agent pane。
   * `params.command` 为 agent 命令（claude/codex/opencode/任意 shell 命令）。
   * `cwdOverride` 为项目路径，优先于 params.cwd。
   */
  spawn(
    paneId: string,
    params: SpawnAgentParams,
    env: Record<string, string>,
    cwdOverride?: string,
    size?: { cols: number; rows: number },
  ): SpawnResult {
    if (this.runtimes.has(paneId)) {
      return { ok: false, error: `pane ${paneId} already exists`, reason: 'duplicate' };
    }

    // 拆分命令与参数：若 command 含空格，取第一个 token 为可执行文件，其余并入参数。
    const tokens = params.command.trim().split(/\s+/).filter(Boolean);
    const commandName = tokens[0] ?? params.command;
    const extraArgs = tokens.slice(1);
    const args = [...extraArgs, ...(params.args ?? [])];

    // ConPTY 不会解析 PATHEXT，必须显式解析出真实路径，否则报 error code 2。
    const executable = resolveExecutable(commandName);
    if (!executable) {
      return {
        ok: false,
        reason: 'not-found',
        error: `Command not found: ${commandName}. Install it and make sure it is on PATH.`,
      };
    }

    const cwd = cwdOverride ?? params.cwd ?? process.cwd();

    /*
     * `.cmd` / `.bat` 不能直接交给 CreateProcess，需用 cmd.exe 包装启动。
     * 对照 herdr `plugin_command.rs` 的 `command_for_program`：
     * 解析出的程序是批处理文件时，改为 `cmd.exe /d /c <program> <args>`。
     * Unix 下 `isWindowsBatchFile` 恒为 false，此分支不生效。
     */
    const batch = isWindowsBatchFile(executable);
    const comSpec = process.env.ComSpec ?? 'cmd.exe';
    const spawnFile = batch ? (resolveExecutable(comSpec) ?? comSpec) : executable;
    const spawnArgs = batch ? ['/d', '/c', executable, ...args] : args;

    let ptyProcess: pty.IPty;
    try {
      /*
       * 初始尺寸取渲染侧传入的值。
       *
       * 这里曾硬编码 120x40，而 xterm 实际尺寸不同，
       * 导致 TUI 按错误尺寸排版、内容画到可视区外。
       * 渲染侧现在在 spawn 时即告知真实尺寸，后续 resize 只做增量修正。
       */
      const cols = size?.cols && size.cols > 0 ? size.cols : 120;
      const rows = size?.rows && size.rows > 0 ? size.rows : 40;
      /*
       * useConpty 是 Windows 专有选项（ConPTY）；macOS / Linux 用 forkpty，
       * 该字段无意义。显式只在 Windows 下带上，避免向 Unix 传无关选项。
       */
      const spawnOptions: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions = {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
        encoding: 'utf8',
        handleFlowControl: false,
        ...(isWindows ? { useConpty: true } : {}),
      };
      ptyProcess = pty.spawn(spawnFile, spawnArgs, spawnOptions);
    } catch (error) {
      return {
        ok: false,
        reason: 'spawn-failed',
        error: `Failed to start ${commandName}: ${describeError(error)}`,
      };
    }

    const runtime: PtyRuntime = {
      paneId,
      pty: ptyProcess,
      buffer: '',
      disposed: false,
    };
    this.runtimes.set(paneId, runtime);

    ptyProcess.onData((data) => {
      if (runtime.disposed) return;
      runtime.buffer = (runtime.buffer + data).slice(-MAX_BUFFER_CHARS);
      this.callbacks.onData(paneId, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      if (runtime.disposed) return;
      runtime.disposed = true;
      this.runtimes.delete(paneId);
      this.callbacks.onExit(paneId, exitCode, signal);
    });

    return { ok: true, runtime };
  }

  /** 一键创建默认 shell（用于「Terminal」预设缺失时的回退）。 */
  defaultShellCommand(): string {
    return resolveDefaultShell().shell;
  }

  /** 该 pane 是否已有运行中的进程。 */
  has(paneId: string): boolean {
    const rt = this.runtimes.get(paneId);
    return !!rt && !rt.disposed;
  }

  write(paneId: string, data: string): void {
    const rt = this.runtimes.get(paneId);
    if (rt && !rt.disposed) {
      rt.pty.write(data);
    }
  }

  resize(paneId: string, cols: number, rows: number): void {
    const rt = this.runtimes.get(paneId);
    if (rt && !rt.disposed) {
      try {
        rt.pty.resize(Math.max(1, cols), Math.max(1, rows));
      } catch {
        // resize 与进程退出可能竞争，忽略
      }
    }
  }

  /** 取 pane 的终端快照（供 agent 检测）。 */
  snapshot(paneId: string): string {
    return this.runtimes.get(paneId)?.buffer ?? '';
  }

  kill(paneId: string): void {
    const rt = this.runtimes.get(paneId);
    if (rt && !rt.disposed) {
      rt.disposed = true;
      try {
        rt.pty.kill();
      } catch {
        // 进程可能已退出
      }
      this.runtimes.delete(paneId);
    }
  }

  disposeAll(): void {
    for (const paneId of [...this.runtimes.keys()]) {
      this.kill(paneId);
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
