/**
 * 官方集成声明 —— 一个智能体的 hook / 扩展 / 插件怎么装、装到哪、版本是多少。
 *
 * 这里只有**声明**（路径是纯函数，不做 IO）；真正的读写实现在
 * `electron/agents/core/integration/`。这样渲染进程也能知道「该智能体是否支持集成」，
 * 不必再靠 `hookStatus === 'unsupported'` 反推。
 */

import type { HostEnv } from './host';

/**
 * 集成形态。
 *
 * - `'json-hooks'`  ：在 JSON/JSONC 配置里注册 hook 事件（11 个 agent，可用数据表达）
 * - `'extension'`   ：写一个扩展文件，由 agent 自己从目录加载（pi / omp / kilo）
 * - `'plugin'`      ：写插件目录 + 注册入口（opencode / hermes）
 * - `'web-plugin'`  ：给被托管的 web 服务装插件（dsh）
 */
export type IntegrationKind = 'json-hooks' | 'extension' | 'plugin' | 'web-plugin';

export interface IntegrationSpec {
  readonly kind: IntegrationKind;

  /**
   * 集成版本号（**唯一来源**）。
   *
   * 资产脚本里的 `HERDR_DESKTOP_INTEGRATION_VERSION` 标记必须与之相等，
   * 由 `npm run test:integration-version` 守卫 —— 取代重构前「两处手工同步」
   * 的隐式约束（那份约束已经漂移过一次）。
   */
  readonly version: number;

  /** 配置目录；返回 null 表示当前环境不适用（如无法确定家目录）。 */
  readonly configDir: (host: HostEnv) => string | null;

  /** 集成产物路径（用于判断是否已安装、读取版本标记）。 */
  readonly artifactPath: (host: HostEnv) => string | null;

  /**
   * 额外的一致性校验；false 表示「装了但已失效」，状态报 `outdated`。
   *
   * 对应重构前挂在 `hookStatuses()` 末尾的两个事后特例：
   * opencode 的 TUI 注册校验、grok 的配置漂移校验。
   */
  readonly validate?: (host: HostEnv) => boolean;

  /**
   * JSON hooks 的 layout 声明（**纯数据**）。
   *
   * 「这个智能体的 hook 事件表长什么样、写进哪个配置文件、用什么容器形状」是
   * 智能体自己的知识，所以放在 descriptor 里，而不是集中在安装流程的注册表里。
   * 只有 `kind === 'json-hooks'` 且可由通用安装器装配的智能体才声明它；
   * 有特殊配置协议的（codex 的 TOML、kimi 的版本闸门等）在自己的安装器里处理。
   */
  readonly hooks?: JsonHooksLayoutData;
}

/** hook 条目在配置里的容器形状（对应 herdr 的四种 hook 容器）。 */
export type JsonHooksShape = 'nested' | 'flat' | 'direct' | 'simple';

/** 一条 hook 事件：`[事件名, action]`，可选逐事件选项。 */
export type JsonHooksEventData = readonly [
  event: string,
  action: string,
  options?: { matcher?: string; background?: boolean },
];

/**
 * JSON hooks 集成的声明式 layout。
 *
 * 这些字段原先硬编码在 `electron/runtime/integration/index.ts` 的
 * `buildHookTargets()` 里（每个智能体一段对象字面量），属于**智能体知识**，
 * 现在回到各自的 descriptor。
 */
export interface JsonHooksLayoutData {
  /** 配置文件（相对 configDir）。 */
  readonly configFile: string;
  /** hook 容器形状。 */
  readonly shape: JsonHooksShape;
  /** 主事件名（如 `SessionStart`）。 */
  readonly event: string;
  /** 额外状态事件（主事件会自动补一条 `[event, 'session']`）。 */
  readonly stateEvents?: readonly JsonHooksEventData[];
  /** 旧版本装过、现在要清理的事件。 */
  readonly removedEvents?: readonly (readonly [string, string])[];
  /** 所有事件的默认 matcher（逐事件可覆写）。 */
  readonly matcher?: string;
  /** 执行超时；单位随 CLI 而异（秒 / 毫秒）。 */
  readonly timeout?: number;
  /** 静默模式（letta）：hook 不向终端输出。 */
  readonly quiet?: boolean;
  /** 是否维护 `version: 1`（cursor）。 */
  readonly withVersion?: boolean;
  /** 命令是否用 PowerShell `-EncodedCommand`（mastracode）。 */
  readonly encodedCommand?: boolean;
  /** 产物子目录（相对 configDir）；null = 根目录。 */
  readonly artifactSubdir: string | null;
  /** 是否用「会话专用脚本名」（qwen / letta 的 `*-agent-session.*`）。 */
  readonly sessionScript?: boolean;
}
