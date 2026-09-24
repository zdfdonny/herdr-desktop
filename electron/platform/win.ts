/**
 * Windows 平台实现 —— 对应 herdr `src/platform/` 的隔离原则。
 *
 * Windows 特有行为全部收敛在本文件，通过 `Platform` 接口对外暴露；
 * macOS / Linux 见 `unix.ts`（由 `darwin.ts` / `linux.ts` 复用），
 * 由 `index.ts` 按 `process.platform` 分发，核心模块零平台判断。
 */

import { existsSync } from 'node:fs';
import { join, isAbsolute, extname } from 'node:path';
import type { PlatformEnv, ResolvedShell, Platform } from './types';

export type { PlatformEnv, ResolvedShell };

/**
 * 解析启动 agent 子进程所需的环境变量。
 * Windows 下 node-pty 直接继承父进程环境，此处仅做必要的补全（TERM 等）。
 */
export function resolveLaunchEnv(): PlatformEnv {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'herdr-desktop',
  };
  return { env, resolved: true };
}

/**
 * 解析默认 shell。
 * Windows 优先使用 PowerShell，回退到 cmd。
 */
export function resolveDefaultShell(): ResolvedShell {
  const powershell = resolveExecutable('powershell.exe');
  if (powershell) {
    return { shell: powershell, args: ['-NoLogo'] };
  }
  return {
    shell: process.env.ComSpec ?? 'cmd.exe',
    args: [],
  };
}

/**
 * Windows 可执行文件扩展名列表，取自 PATHEXT。
 *
 * 对应 herdr `plugin_command.rs` 的 `windows_path_extensions`：
 * 读环境变量 PATHEXT 并按 `;` 拆分、归一化成 `.ext` 形式；
 * 未设置或为空时回退到 `.COM;.EXE;.BAT;.CMD`。
 *
 * 注意：不含 `.ps1` 与空字符串——它们不能直接交给 CreateProcess 启动，
 * 混入会误判「已安装」。
 */
function windowsPathExtensions(): string[] {
  const pathext = process.env.PATHEXT;
  if (pathext) {
    const extensions = pathext
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => (part.startsWith('.') ? part : `.${part}`));
    if (extensions.length > 0) return extensions;
  }
  return ['.COM', '.EXE', '.BAT', '.CMD'];
}

/** 命令名是否已带文件扩展名（如 `cursor-agent.cmd`）。 */
function hasExtension(command: string): boolean {
  return /\.[a-z0-9]+$/i.test(command);
}

/**
 * 把一个命令名解析为绝对路径。
 *
 * Windows 上 ConPTY 的 `connect` 不会像 shell 那样解析 PATHEXT，
 * 因此需要显式解析出真实的可执行文件路径，否则会得到 error code 2
 * （ERROR_FILE_NOT_FOUND）。
 *
 * 解析规则对照 herdr `plugin_command.rs` 的 `resolve_windows_program`：
 * - 已带路径分隔符：直接按绝对/相对路径检查是否存在；
 * - 已带扩展名：仅在 PATH 各目录里按原名精确查找；
 * - 无扩展名：按 PATHEXT 逐个拼接查找。
 *
 * @returns 绝对路径；无法解析时返回 null。
 */
export function resolveExecutable(command: string, pathValue?: string): string | null {
  if (!command) return null;

  // 已带路径分隔符的直接检查（绝对或相对）
  if (command.includes('/') || command.includes('\\')) {
    if (isAbsolute(command)) {
      return existsSync(command) ? command : null;
    }
    const resolved = join(process.cwd(), command);
    return existsSync(resolved) ? resolved : null;
  }

  /*
   * 空串视为「未提供」：调用方传空串通常意味着登录 shell / PowerShell 环境
   * 解析失败，此时回退到进程继承的 PATH，而不是把查找目录清空。
   * （`??` 只挡 null/undefined，挡不住空串。）
   */
  const inherited = process.env.PATH ?? process.env.Path ?? '';
  const searchPath = pathValue && pathValue.length > 0 ? pathValue : inherited;
  const dirs = searchPath.split(';').filter(Boolean);

  // 已带扩展名：按原名精确查找，不再追加 PATHEXT。
  if (hasExtension(command)) {
    for (const dir of dirs) {
      const full = join(dir.trim(), command);
      if (existsSync(full)) return full;
    }
    return null;
  }

  // 无扩展名：按 PATHEXT 顺序逐个拼接。
  const extensions = windowsPathExtensions();
  for (const dir of dirs) {
    for (const ext of extensions) {
      const full = join(dir.trim(), `${command}${ext}`);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/** 命令是否可被解析到（`pathValue` 语义同 `resolveExecutable`）。 */
export function isCommandAvailable(command: string, pathValue?: string): boolean {
  return resolveExecutable(command, pathValue) !== null;
}

/**
 * 是否为 Windows 批处理文件（`.cmd` / `.bat`，大小写不敏感）。
 *
 * 对应 herdr `plugin_command.rs` 的 `is_windows_batch_path`：
 * 这类文件不能直接交给 CreateProcess，需用 `cmd.exe /d /c` 包装启动。
 */
export function isWindowsBatchFile(file: string): boolean {
  const ext = extname(file).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

/** Windows 平台实现（供 `index.ts` 统一分发）。 */
export const win: Platform = {
  resolveLaunchEnv,
  resolveDefaultShell,
  resolveExecutable,
  isCommandAvailable,
  isWindowsBatchFile,
};
