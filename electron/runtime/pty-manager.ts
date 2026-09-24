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
import {
  statSync,
  lstatSync,
  realpathSync,
  openSync,
  readSync,
  closeSync,
  accessSync,
  constants,
} from 'node:fs';
import type { PtyRuntime, PtyCallbacks } from './types';
import type { SpawnAgentParams } from '../../shared/state';
import { resolveExecutable, resolveDefaultShell, isWindowsBatchFile, isWindows } from '../platform';

const MAX_BUFFER_CHARS = 200_000;

/**
 * 目录是否存在且确实是目录。
 *
 * 必须检查 isDirectory：路径存在但是个文件时，用它当 cwd 同样会在
 * 创建进程那一步失败，报错形式与「目录不存在」完全一样。
 */
function isUsableDirectory(dir: string): boolean {
  if (!dir) return false;
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** spawn 结果：成功带 runtime，失败带可展示的错误。 */
export type SpawnResult =
  | {
      ok: true;
      runtime: PtyRuntime;
      /**
       * 请求的工作目录不可用时，实际回退到的目录；正常时为 undefined。
       * 由调用方决定是否提示用户（agent 已启动，只是不在预期目录）。
       */
      cwdFallback?: { requested: string; used: string };
    }
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

    /*
     * ConPTY 不会解析 PATHEXT，必须显式解析出真实路径，否则报 error code 2。
     *
     * 必须传入 `env.PATH`（调用方从登录 shell 解析出的那份），不能用进程继承的
     * `process.env.PATH`：从 Finder / .desktop 启动的 GUI 应用拿不到用户真实 PATH，
     * macOS 上通常只有 `/usr/bin:/bin:/usr/sbin:/sbin`，homebrew 的 `/opt/homebrew/bin`
     * 和 npm global 都不在其中。
     *
     * 探测（router.probeAgentAvailability）走的是登录 shell PATH，所以不传的话会出现
     * 「列表里显示已安装、点进去却报 Command not found」的自相矛盾结果。
     */
    const pathValue = env.PATH ?? env.Path ?? '';
    const executable = resolveExecutable(commandName, pathValue);
    if (!executable) {
      return {
        ok: false,
        reason: 'not-found',
        error: `Command not found: ${commandName}. Install it and make sure it is on PATH.`,
      };
    }

    /*
     * 工作目录必须存在，否则 forkpty / CreateProcess 会在**创建进程**这一步失败：
     * - macOS / Linux：`posix_spawnp failed`（errno 是 ENOENT，但 node-pty 不透出）
     * - Windows：`Cannot create process, error code: 267`（ERROR_DIRECTORY）
     *
     * 报错里只有命令名，看不出真正原因是目录不存在，极难排查。
     * 常见触发场景：项目目录被删/改名/移动，或 session.json 从别的机器同步过来，
     * 其中记录的是本机不存在的路径。
     *
     * 这里不直接失败，而是回退到用户主目录（再退到进程 cwd），保证 agent 仍能启动；
     * 目录无效的事实通过 `cwdFallback` 回传，由调用方提示用户。
     */
    const requestedCwd = cwdOverride ?? params.cwd ?? process.cwd();
    let cwd = requestedCwd;
    let cwdFallback: string | undefined;
    if (!isUsableDirectory(cwd)) {
      const home = process.env.HOME ?? process.env.USERPROFILE;
      const fallback = home && isUsableDirectory(home) ? home : process.cwd();
      cwdFallback = cwd;
      cwd = fallback;
    }

    /*
     * `.cmd` / `.bat` 不能直接交给 CreateProcess，需用 cmd.exe 包装启动。
     * 对照 herdr `plugin_command.rs` 的 `command_for_program`：
     * 解析出的程序是批处理文件时，改为 `cmd.exe /d /c <program> <args>`。
     * Unix 下 `isWindowsBatchFile` 恒为 false，此分支不生效。
     */
    const batch = isWindowsBatchFile(executable);
    const comSpec = process.env.ComSpec ?? 'cmd.exe';
    // 同样按登录 shell 的 PATH 解析，避免与上面的 executable 用了两份 PATH。
    const spawnFile = batch ? (resolveExecutable(comSpec, pathValue) ?? comSpec) : executable;
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
      /*
       * 把已知的底层错误翻译成人能看懂的话。
       *
       * `posix_spawnp failed` / `error code: 267` 是 forkpty / CreateProcess
       * 在「创建进程」这一步失败的统称，真正原因（目录不存在、架构不匹配、
       * 二进制损坏、无执行权限）都不会体现在这句话里，直接抛给用户等于没说。
       */
      const detail = describeError(error);
      const hint = describeSpawnFailure(detail, executable, cwd, pathValue);
      return {
        ok: false,
        reason: 'spawn-failed',
        error: `Failed to start ${commandName}: ${detail}${hint}`,
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

    return { ok: true, runtime, ...(cwdFallback ? { cwdFallback: { requested: cwdFallback, used: cwd } } : {}) };
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

/**
 * 为「创建进程失败」这类不透明的错误补一句可操作的原因。
 *
 * node-pty 在 forkpty / CreateProcess 失败时只透出一句笼统的话：
 * - macOS / Linux：`posix_spawnp failed.`
 * - Windows：`Cannot create process, error code: 267`
 *
 * 这句话对排查毫无帮助——它可能是目录不存在、二进制架构不匹配、文件损坏、
 * 脚本 shebang 指向不存在的解释器、或没有执行权限。
 *
 * 与其猜测，不如直接**读取可执行文件本身**，把事实摆出来：
 * - 是脚本还是二进制？脚本的 shebang 依赖谁、那个人在不在？
 * - 是 Mach-O / ELF？什么架构？和当前进程架构冲不冲突？
 * 这样 macOS 上「x86_64 vs arm64」这类问题一句话就能说清。
 *
 * 注意：走到这里时 `cwd` 已经过 isUsableDirectory 校验，所以正常情况下
 * 不会再是「目录不存在」；仍保留该判断以覆盖校验与实际创建之间的竞态
 * （目录在校验后被删除）。
 */
function describeSpawnFailure(
  detail: string,
  executable: string,
  cwd: string,
  pathValue: string,
): string {
  const lower = detail.toLowerCase();
  const isSpawnFailure =
    lower.includes('posix_spawnp') ||
    lower.includes('cannot create process') ||
    lower.includes('error code: 267') ||
    lower.includes('enoent');

  if (!isSpawnFailure) return '';

  if (!isUsableDirectory(cwd)) {
    return `\n→ 工作目录不存在或不是目录：${cwd}`;
  }

  // 优先给出「检查文件本身」得到的确定结论，而不是空泛的猜测。
  const inspected = inspectExecutable(executable, pathValue);
  if (inspected) return inspected;

  return `\n→ 可执行文件：${executable}\n  请确认该文件存在、有执行权限，且架构与当前系统匹配。`;
}

/** 只读文件头部最多 maxBytes 字节；失败返回空 Buffer。 */
function readHead(file: string, maxBytes: number): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return n <= 0 ? Buffer.alloc(0) : buf.subarray(0, n);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 读取可执行文件，给出**事实性**诊断（而非猜测）。
 *
 * 覆盖三类最常见、且 `posix_spawnp failed` 一句话根本说不清的情况：
 * 1. 脚本：shebang 指向的解释器不存在，或 `#!/usr/bin/env X` 里的 X 不在 PATH；
 * 2. Mach-O：Intel (x86_64/i386) 二进制跑在 arm64 上却没有 Rosetta 2；
 * 3. 误放了一个 Linux ELF 二进制，macOS 无法直接运行。
 *
 * 只在 darwin 上启用（Mach-O/ELF 解析对 Linux 同样有意义，但当前 bug 场景
 * 集中在 macOS；保持范围最小）。返回空串表示「读不出有效结论」，由调用方
 * 退回到通用提示。
 */
function inspectExecutable(file: string, pathValue: string): string {
  if (process.platform !== 'darwin') return '';

  let target = file;
  try {
    if (lstatSync(file).isSymbolicLink()) {
      try {
        target = realpathSync(file);
      } catch {
        return `\n→ ${file} 是符号链接，但目标已失效（broken symlink）。`;
      }
    }

    const st = statSync(target);
    if (!st.isFile()) {
      return `\n→ ${target} 不是常规文件，无法直接执行。`;
    }

    const head = readHead(target, 512);
    if (head.length < 4) {
      return `\n→ ${target} 内容过短（${head.length} 字节），不是有效的可执行文件。`;
    }

    // 脚本：以 "#!" 开头
    if (head[0] === 0x23 && head[1] === 0x21) {
      return inspectShebang(head, pathValue);
    }

    // 二进制：Mach-O / ELF
    return inspectBinary(head, target);
  } catch (error) {
    return `\n→ 无法读取 ${file}：${describeError(error)}`;
  }
}

/** 解析脚本 shebang，检查它依赖的解释器是否真的在。 */
function inspectShebang(head: Buffer, pathValue: string): string {
  const nl = head.indexOf(0x0a);
  const raw = (nl === -1 ? head : head.subarray(0, nl)).toString('utf8').trim();
  const shebang = raw.startsWith('#!') ? raw.slice(2).trim() : raw;
  const parts = shebang.split(/\s+/).filter(Boolean);
  const interpreter = parts[0];

  if (!interpreter) {
    return `\n→ 这是脚本，但 shebang 为空：${raw}`;
  }

  // `#!/usr/bin/env node` —— 真正要找的解释器是第二个 token。
  if (interpreter === '/usr/bin/env' || interpreter === 'env') {
    const prog = parts[1];
    if (!prog) {
      return `\n→ 这是脚本，但 shebang 不完整：${raw}`;
    }
    const resolved = resolveExecutable(prog, pathValue);
    if (!resolved) {
      return (
        `\n→ 这是脚本，shebang 依赖 \`${prog}\`，但它在 PATH 中找不到。\n` +
        `  常见于用 nvm/fnm/volta/asdf 管理的 node：GUI 应用拿到的 PATH 里没有 node。`
      );
    }
    return `\n→ 这是脚本，shebang 依赖 \`${prog}\`（已找到：${resolved}），解释器不是失败原因。`;
  }

  // 绝对路径解释器：直接检查是否存在、可执行。
  try {
    accessSync(interpreter, constants.X_OK);
    return `\n→ 这是脚本，shebang 解释器 ${interpreter} 存在且可执行。`;
  } catch {
    return `\n→ 这是脚本，但 shebang 指向的解释器不存在或不可执行：${interpreter}。`;
  }
}

/** 解析 Mach-O / ELF 头，报出架构事实。 */
function inspectBinary(head: Buffer, target: string): string {
  // ELF：Linux 二进制。
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
    return `\n→ ${target} 是 Linux ELF 二进制，无法在 macOS 直接运行。`;
  }

  const magic = head.readUInt32BE(0);
  // 通用二进制（universal）：同时含 arm64 与 x86_64，架构必然兼容。
  const isFat = magic === 0xcafebabe || magic === 0xbebafeca;
  if (isFat) {
    return `\n→ ${target} 是通用二进制（universal），架构兼容，不是失败原因。`;
  }

  // Mach-O 魔数。现代 mac 都是小端，盘上字节序对应 CIGAM 常量。
  const isLeMachO = magic === 0xcffaedfe || magic === 0xcefaedfe; // 64/32 位小端
  const isBeMachO = magic === 0xfeedfacf || magic === 0xfeedface; // 64/32 位大端（已罕见）
  if (!isLeMachO && !isBeMachO) {
    const hex = head.subarray(0, 4).toString('hex');
    return `\n→ ${target} 既不是脚本也不是 Mach-O/ELF 二进制（头 4 字节 ${hex}），文件可能损坏。`;
  }

  // cputype 在偏移 4（4 字节）。
  const cpu = isLeMachO ? head.readUInt32LE(4) : head.readUInt32BE(4);
  const CPU_ARM64 = 0x0100000c;
  const CPU_X86_64 = 0x01000007;
  const CPU_X86 = 0x00000007;

  if (cpu === CPU_ARM64) {
    return `\n→ ${target} 是 arm64 二进制，与 Apple Silicon 匹配，架构不是失败原因。`;
  }
  if (cpu === CPU_X86_64 || cpu === CPU_X86) {
    const name = cpu === CPU_X86_64 ? 'x86_64' : 'i386';
    if (process.arch === 'arm64') {
      return (
        `\n→ ${target} 是 Intel (${name}) 二进制，但当前进程是 arm64 (Apple Silicon)。\n` +
        `  需要 Rosetta 2 才能运行 Intel 二进制：\n` +
        `    softwareupdate --install-rosetta\n` +
        `  装完重试；若已安装仍失败，则架构不是原因。`
      );
    }
    return `\n→ ${target} 是 Intel (${name}) 二进制（当前进程 ${process.arch}）。`;
  }

  return `\n→ ${target} 是 Mach-O，架构 0x${cpu.toString(16)}，无法判断兼容性。`;
}
