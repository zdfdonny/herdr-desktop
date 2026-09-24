/**
 * Linux 平台实现。
 *
 * 复用 `unix.ts` 的 POSIX 语义。Linux 特有之处：
 * - 默认 shell 通常是 bash（`/bin/bash`），少数发行版 / 用户用 zsh；
 * - 从 `.desktop` 启动的 GUI 应用同样不继承用户 shell 环境，
 *   需要走登录 shell 捞 PATH（nvm、`~/.local/bin`、asdf 等）。
 */

import {
  resolveLaunchEnv,
  resolveDefaultShell,
  resolveExecutable,
  isCommandAvailable,
  isWindowsBatchFile,
} from './unix';
import type { Platform } from './types';

export const linux: Platform = {
  resolveLaunchEnv,
  resolveDefaultShell,
  resolveExecutable,
  isCommandAvailable,
  isWindowsBatchFile,
};
