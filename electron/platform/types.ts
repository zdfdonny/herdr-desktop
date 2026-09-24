/**
 * 平台抽象层的公共类型。
 *
 * 抽到独立文件是为了让 `win.ts` / `darwin.ts` / `linux.ts` 平级共享，
 * 避免「类型从 win.ts 导出」这种隐含的 Windows 中心假设。
 */

export interface PlatformEnv {
  /** 用于启动 agent 子进程的完整环境变量。 */
  env: Record<string, string>;
  /**
   * 是否成功解析出「用户真实登录环境」。
   * - Windows：通常直接继承，恒为 true；
   * - macOS / Linux：需从登录 shell 捞取，失败时回退继承环境并置 false。
   */
  resolved: boolean;
}

export interface ResolvedShell {
  /** 默认 shell 可执行文件路径。 */
  shell: string;
  /** shell 参数前缀（如登录 shell 的 `-l`、Windows 的 `-NoLogo`）。 */
  args: string[];
}

/**
 * 平台实现必须提供的接口。
 * 三个平台文件各自实现它，`index.ts` 按 `process.platform` 分发。
 */
export interface Platform {
  resolveLaunchEnv(): PlatformEnv;
  resolveDefaultShell(): ResolvedShell;
  /**
   * 解析命令为绝对路径。
   *
   * `pathValue` 用于覆盖查找用的 PATH：GUI 启动的 macOS 应用拿不到用户
   * 真实 PATH，探测时必须传入 `resolveLaunchEnv()` 里那份登录 shell 的 PATH，
   * 否则会误判「已安装」为「未安装」。
   */
  resolveExecutable(command: string, pathValue?: string): string | null;
  /** 命令是否可被解析到（`pathValue` 语义同 `resolveExecutable`）。 */
  isCommandAvailable(command: string, pathValue?: string): boolean;
  /**
   * 该路径是否为需要 shell 包装才能启动的批处理文件。
   * 仅 Windows 会返回 true（`.cmd` / `.bat`）；Unix 恒为 false。
   */
  isWindowsBatchFile(file: string): boolean;
}
