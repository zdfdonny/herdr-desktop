/**
 * 集成安装器契约 —— 「一个智能体的集成如何装/卸/判状态」。
 *
 * 这是重构前 `HookTarget`（写在 `integration/index.ts` 里）的正式归属：
 * 把它移到 `electron/agents/` 下，与 descriptor 一起构成「一个智能体一处实现」。
 *
 * 设计约束：
 * - 所有方法都**必须**是幂等的：重复 install 不产生重复条目、重复 uninstall 不报错；
 * - `version()` 必须来自 descriptor（唯一来源），不要在实现里写死数字；
 * - 智能体私有的「装好了但已失效」判据放 `validate()`，不要写回通用的状态汇总函数。
 */
export interface IntegrationInstaller {
  /** 配置目录；null 表示当前环境不适用（如无法确定家目录）。 */
  configDir(): string | null;

  /** 集成产物路径（用于判断是否已安装、读取版本标记）。 */
  artifactPath(): string | null;

  /** 产物是否已存在且带本项目标记。 */
  isInstalled(): boolean;

  /** 该智能体要求的集成版本（来自 descriptor）。null = 不校验版本。 */
  version(): number | null;

  /**
   * 额外的「已装但失效」校验（配置漂移 / 注册失效）。
   *
   * 缺省表示产物存在且版本够就算装好。只有需要跨文件校验的智能体才实现
   * （opencode 的 TUI 注册、grok 的配置一致性）。
   */
  validate?(): boolean;

  /** 安装（或更新）。必须幂等。 */
  install(): Promise<void>;

  /** 卸载。必须幂等，且要清理历史遗留事件。 */
  uninstall(): Promise<void>;
}
