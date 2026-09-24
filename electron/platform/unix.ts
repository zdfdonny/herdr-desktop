/**
 * POSIX（macOS / Linux）平台实现的公共部分。
 *
 * 与 `win.ts` 对应：把「解析可执行文件」「解析默认 shell」「解析启动环境」
 * 三件事按 Unix 语义实现，供 `darwin.ts` / `linux.ts` 复用。
 *
 * 与 Windows 的关键差异：
 * - 无 PATHEXT：命令名就是文件名，只按 PATH 顺序找同名可执行文件；
 * - 可执行位有语义：候选文件必须带 `X_OK`，否则不算「已安装」
 *   （这正是 herdr 用 `access(2)` 判定可用性的等价做法）；
 * - 无 `.cmd`/`.bat` 包装概念；
 * - 启动环境需要从**登录 shell** 里捞（GUI 启动的 app 拿不到用户 shell 的 PATH，
 *   见 `resolveLaunchEnv`）。
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { isAbsolute, join, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { PlatformEnv, ResolvedShell } from './types';

/** PATH 分隔符：POSIX 为 `:`。 */
export function pathDirs(pathValue = process.env.PATH ?? ''): string[] {
  return pathValue.split(delimiter).filter((dir) => dir.length > 0);
}

/**
 * macOS 上 GUI 应用常见的「探测不到已安装智能体」兜底目录。
 *
 * 即便登录 shell 环境解析成功，仍可能有目录不在 PATH 里（例如用户只在
 * 某个 profile 里手动 export，或用了 GUI 安装器）。这些是 homebrew /
 * 官方安装脚本的默认落点，作为补充目录追加在登录 shell PATH 之后。
 */
function fallbackDirs(): string[] {
  if (process.platform !== 'darwin') return [];
  const home = process.env.HOME;
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    ...(home ? [`${home}/.local/bin`, `${home}/bin`] : []),
  ];
}

/** 文件是否存在且可执行。 */
function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把一个命令名解析为绝对路径。
 *
 * 对照 herdr `src/platform/{linux,macos}.rs` 的做法（沿 PATH 找可执行文件）：
 * - 含 `/`：按绝对/相对路径直接判定（相对路径基于 cwd）；
 * - 否则：按 PATH 顺序找同名且带可执行位的文件。
 *
 * `pathValue` 缺省用进程继承的 PATH。**从 Finder 启动的 GUI 应用拿到的
 * PATH 往往只有 `/usr/bin:/bin:/usr/sbin:/sbin`**，探测智能体时必须传入
 * 登录 shell 解析出的那份 PATH（见 `resolveLaunchEnv`），否则 homebrew /
 * npm global 里的 claude、codex、opencode 会被误判为未安装。
 *
 * 注意 Unix 下**不做扩展名补齐**：`cursor-agent` 就是 `cursor-agent`，
 * 不存在 `cursor-agent.cmd` 这种映射。
 *
 * @returns 绝对路径；无法解析时返回 null。
 */
export function resolveExecutable(command: string, pathValue?: string): string | null {
  if (!command) return null;

  if (command.includes('/')) {
    const full = isAbsolute(command) ? command : join(process.cwd(), command);
    return isExecutableFile(full) ? full : null;
  }

  /*
   * `pathValue` 为空串时视为「未提供」：调用方传空串通常意味着登录 shell 解析
   * 失败或环境里没有 PATH，此时回退到进程继承的 PATH，而不是把查找目录清空。
   */
  const explicitPath = pathValue !== undefined && pathValue.length > 0;
  const dirs = explicitPath
    ? pathDirs(pathValue)
    : pathDirs(process.env.PATH ?? '');

  for (const dir of dirs) {
    const full = join(dir, command);
    if (isExecutableFile(full)) return full;
  }

  /*
   * 显式传入 PATH 时，再补查进程继承的 PATH。
   *
   * 登录 shell 解析出的 PATH 未必完整：某些 shell 配置会在非交互分支里
   * 覆盖而非追加 PATH，导致捞回来的那份反而比继承的更短。两份都查一遍
   * 才能保证「探测」与「启动」都不会漏掉已安装的命令。
   */
  if (explicitPath) {
    for (const dir of pathDirs(process.env.PATH ?? '')) {
      if (dirs.includes(dir)) continue;
      const full = join(dir, command);
      if (isExecutableFile(full)) return full;
    }
  }

  // 两份 PATH 里都没有时，再补查 macOS 的常见安装目录。
  if (explicitPath) {
    for (const dir of fallbackDirs()) {
      if (dirs.includes(dir)) continue;
      const full = join(dir, command);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

/** 命令是否可被解析到（`pathValue` 语义同 `resolveExecutable`）。 */
export function isCommandAvailable(command: string, pathValue?: string): boolean {
  return resolveExecutable(command, pathValue) !== null;
}

/** Unix 下不存在批处理包装，恒为 false（保持与 win 的接口一致）。 */
export function isWindowsBatchFile(): boolean {
  return false;
}

/**
 * 候选登录 shell，按优先级排列。
 *
 * 优先读用户 `$SHELL`（尊重用户选择，如 zsh / fish），
 * 再按平台回退到系统常见 shell。全部不可用时兜底 `/bin/sh`。
 */
function loginShellCandidates(): string[] {
  const candidates: string[] = [];
  const userShell = process.env.SHELL;
  if (userShell && userShell.startsWith('/')) {
    candidates.push(userShell);
  }
  // macOS 默认 zsh；Linux 常见 bash。两者都回退 /bin/sh。
  candidates.push('/bin/zsh', '/bin/bash', '/bin/sh');
  return candidates;
}

/** 解析默认 shell（交互式，用于「Terminal」预设与回退）。 */
export function resolveDefaultShell(): ResolvedShell {
  for (const candidate of loginShellCandidates()) {
    if (existsSync(candidate)) {
      // -l 走登录 shell：macOS 上才能读到用户 profile 里的 PATH。
      return { shell: candidate, args: ['-l'] };
    }
  }
  return { shell: '/bin/sh', args: [] };
}

/**
 * 从登录 shell 里取一份完整环境变量。
 *
 * 为什么需要：从 Finder / .desktop 启动的 GUI 应用**不继承**用户终端环境，
 * 于是 `PATH` 里没有 nvm / homebrew / npm global 等目录，
 * 导致「明明装了 claude 却探测不到」。
 * 这里跑一次 `shell -ilc env` 把真实环境捞回来。
 *
 * 失败（超时 / shell 异常）时回退到继承的 `process.env`，保证仍能启动。
 */
export function resolveLaunchEnv(): PlatformEnv {
  const { shell, args } = resolveDefaultShell();

  let env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  let resolved = false;

  try {
    /*
     * `-i` 交互 + `-l` 登录：覆盖 .zprofile/.zshrc/.bash_profile 等，
     * 这是 GUI 应用拿到用户 PATH 的标准做法。
     * `env` 无参输出当前全部环境变量，格式为每行 KEY=VALUE。
     * 5s 超时防止个别 shell 配置卡住启动流程。
     */
    const output = execFileSync(shell, [...args, '-i', '-c', 'env'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const parsed: Record<string, string> = {};
    for (const line of output.split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      // 跳过 shell 注入的函数变量（形如 `BASH_FUNC_xxx%%`）
      if (key.includes('%%')) continue;
      parsed[key] = value;
    }

    if (Object.keys(parsed).length > 0) {
      env = parsed;
      resolved = true;
    }
  } catch {
    // 登录 shell 不可用：保留继承环境，标记未解析
  }

  // 终端能力标记：TUI（opencode 等）依赖这些判断颜色与宽字符支持。
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'herdr-desktop';

  return { env, resolved };
}
