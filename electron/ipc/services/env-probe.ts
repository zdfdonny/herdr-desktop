/**
 * Agent 命令可用性探测。
 *
 * 从 `IpcRouter` 抽出（R1）。它只做一件事：用**登录 shell 解析出的 PATH** 判断
 * 某个命令在不在本机可用 —— 没有业务状态，只有一个 PATH 缓存。
 *
 * 为什么不能直接用 `process.env.PATH`：从 Finder / 桌面图标启动的 Electron
 * 继承的是 launchd 的极简环境，PATH 里没有 nvm / homebrew / volta 装的命令，
 * 会导致「明明装了 claude 却显示不可用」。`resolveLaunchEnv()` 走一次登录 shell
 * 把真实 PATH 取回来。
 */

import { isCommandAvailable, resolveLaunchEnv } from '../../platform';

export class AgentEnvProbe {
  /** 登录 shell 解析出的 PATH；null 表示尚未解析。 */
  private pathCache: string | null = null;

  /** 取探测用的 PATH（首次调用时从登录 shell 解析，之后缓存）。 */
  path(): string {
    if (this.pathCache === null) {
      try {
        const { env } = resolveLaunchEnv();
        this.pathCache = env.PATH ?? env.Path ?? '';
      } catch {
        // 登录 shell 解析失败（极简容器、受限 shell）时退回进程自身的 PATH。
        this.pathCache = process.env.PATH ?? '';
      }
    }
    return this.pathCache;
  }

  /**
   * 探测一批命令的可用性。
   *
   * 入参是完整的命令行（如 `npx claude`），只取第一个词作为命令名。
   * 返回以**原始入参**为键的映射，便于调用方直接对照。
   */
  probe(commands: string[]): Record<string, boolean> {
    const pathValue = this.path();
    const available: Record<string, boolean> = {};
    for (const command of commands) {
      const name = command.trim().split(/\s+/)[0] ?? command;
      available[command] = isCommandAvailable(name, pathValue);
    }
    return available;
  }
}
