/**
 * macOS 平台实现。
 *
 * 复用 `unix.ts` 的 POSIX 语义。macOS 特有之处：
 * - 默认 shell 是 zsh（Catalina 起），且 GUI 应用**必须**从登录 shell 捞环境，
 *   否则 Finder 启动的 app 看不到 homebrew / nvm 的 PATH；
 * - `/usr/local/bin`、`/opt/homebrew/bin`（Apple Silicon）常在用户 shell 配置里追加，
 *   只有走登录 shell 才能拿到。
 */

import {
  resolveLaunchEnv,
  resolveDefaultShell,
  resolveExecutable,
  isCommandAvailable,
  isWindowsBatchFile,
} from './unix';
import type { Platform } from './types';

export const darwin: Platform = {
  resolveLaunchEnv,
  resolveDefaultShell,
  resolveExecutable,
  isCommandAvailable,
  isWindowsBatchFile,
};
