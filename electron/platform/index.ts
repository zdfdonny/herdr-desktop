/**
 * 平台抽象统一入口 —— 对应 herdr `src/platform/` 的隔离原则。
 *
 * 按 `process.platform` 分发到具体实现，对外暴露与平台无关的同一组函数，
 * 因此核心模块（pty-manager / router）里**零平台判断**。
 *
 * 支持：Windows（win.ts）/ macOS（darwin.ts）/ Linux（linux.ts）。
 * 未识别的平台回退到 POSIX 语义（比 Windows 语义更接近通用情况）。
 */

import { win } from './win';
import { darwin } from './darwin';
import { linux } from './linux';
import type { Platform, PlatformEnv, ResolvedShell } from './types';

export type { Platform, PlatformEnv, ResolvedShell };

/** 当前平台的实现。 */
function currentPlatform(): Platform {
  switch (process.platform) {
    case 'win32':
      return win;
    case 'darwin':
      return darwin;
    case 'linux':
      return linux;
    default:
      // 其他类 Unix（freebsd 等）沿用 POSIX 语义
      return linux;
  }
}

const impl = currentPlatform();

export const resolveLaunchEnv = (): PlatformEnv => impl.resolveLaunchEnv();
export const resolveDefaultShell = (): ResolvedShell => impl.resolveDefaultShell();
export const resolveExecutable = (command: string): string | null => impl.resolveExecutable(command);
export const isCommandAvailable = (command: string): boolean => impl.isCommandAvailable(command);
export const isWindowsBatchFile = (file: string): boolean => impl.isWindowsBatchFile(file);

/** 当前平台是否为 Windows（少数必须显式分支的场景使用，如 ConPTY 选项）。 */
export const isWindows = process.platform === 'win32';
