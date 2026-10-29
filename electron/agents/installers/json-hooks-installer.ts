/**
 * JSON/JSONC 形状 hook 集成安装器 —— 模板方法的具体实现。
 *
 * 覆盖 11 个「只是配置路径与事件表不同」的智能体（copilot / devin / droid /
 * qodercli / qwen / letta / cursor / mastracode + claude / codex / kimi 的公共骨架）。
 *
 * 设计要点：**依赖由外部注入**，本类不 import 任何 fs / 平台模块。
 * 这样它能脱离 Electron 与 Vite 的 `?raw` 资产内联单独测试，
 * 也符合 `shared/` 只放纯数据、`electron/agents/` 放实现的分层。
 *
 * 固定骨架（子类/参数只填差异）：
 *
 *   install:  预检配置目标 → 写产物+可执行位 → 读配置 → 移除旧事件 → 写新事件 → 写回
 *   uninstall: 读配置 → 移除当前事件+旧事件 → 写回 → 删产物
 */

/** hook 条目在 agent 配置里的 JSON 形状（对应 herdr 的四种 hook 容器）。 */
export type JsonHookShape = 'nested' | 'flat' | 'direct' | 'simple';

/**
 * 一条要注册的事件。
 *
 * `options` 允许**逐事件**覆写 matcher / background —— 有些智能体只在
 * `SessionStart` 上要 matcher（claude），有些事件要异步执行（claude 的
 * UserPromptSubmit / PostToolUse 走 async 以免拖慢每次工具调用）。
 */
export type HookEvent = readonly [
  event: string,
  action: string,
  options?: { matcher?: string; background?: boolean },
];

/** 安装器需要的 IO 能力（由主进程注入真实实现，测试可注入内存实现）。 */
export interface JsonHooksIo {
  /** 预检配置目标：不可写 / 多硬链接 / 指向目录时抛错，避免写坏用户配置。 */
  checkConfigTarget(path: string): void;
  /** 确保目录存在。 */
  ensureDir(dir: string): Promise<void>;
  /** 写产物文件。 */
  writeArtifact(path: string, content: string): Promise<void>;
  /** 给产物加可执行位（Windows 上为 no-op）。 */
  makeExecutable(path: string): Promise<void>;
  /** 删除产物（不存在不报错）。 */
  removeArtifact(path: string): Promise<void>;
  /** 递归删除目录（插件类智能体卸载时用；缺省时基类只删文件）。 */
  removeDirectory?(path: string): Promise<void>;
  /** 读 JSON/JSONC 配置（不存在返回空对象）。 */
  readJson(path: string): Promise<Record<string, any>>;
  /** 只改一个顶层键并写回（保留其余键与注释）。 */
  writeJsonKey(path: string, key: string, value: unknown): Promise<void>;
}

export interface JsonHooksLayout {
  /** 配置文件路径（相对 configDir，如 `settings.json`）。 */
  readonly configFile: string;
  /** hook 容器形状。 */
  readonly shape: JsonHookShape;
  /** 主事件名（如 `SessionStart`）。 */
  readonly event: string;
  /** 主事件 + 状态事件，顺序即写入顺序。 */
  readonly events: readonly HookEvent[];
  /** 旧版本装过、现在要清理的事件。 */
  readonly removedEvents?: readonly HookEvent[];
  /** hook 条目的 matcher（部分 CLI 支持）。 */
  readonly matcher?: string;
  /** 执行超时；单位随 CLI 而异（秒 / 毫秒）。 */
  readonly timeout?: number;
  /** 静默模式（letta）：hook 不向终端输出。 */
  readonly quiet?: boolean;
  /** 是否在配置里维护 `version: 1`（cursor）。 */
  readonly withVersion?: boolean;
  /** 命令是否用 PowerShell `-EncodedCommand` 编码（mastracode / antigravity）。 */
  readonly encodedCommand?: boolean;
  /** 产物所在子目录（相对 configDir；null = 直接放在 configDir 下）。 */
  readonly artifactSubdir: string | null;
}

/** 形状改写函数（纯函数，由调用方注入，避免本模块依赖 jsonc-parser 的写入工具）。 */
export interface JsonHooksShapeOps {
  ensureHooksObject(root: Record<string, any>): Record<string, any>;
  hooksObjectIfPresent(root: Record<string, any>): Record<string, any> | null;
  ensureHook(
    hooks: Record<string, any>,
    shape: JsonHookShape,
    event: string,
    command: string,
    opts: { matcher?: string; timeout?: number; quiet?: boolean; background?: boolean },
  ): void;
  removeHook(hooks: Record<string, any>, event: string, command: string): boolean;
}

export interface JsonHooksInstallerDeps {
  /** 配置目录（惰性求值：每次安装/卸载时重新解析，环境变量可能变）。 */
  readonly configDir: () => string | null;
  /** 产物路径（惰性求值）。 */
  readonly artifactPath: () => string | null;
  /** 该智能体要求的集成版本（来自 descriptor）。 */
  readonly version: () => number | null;
  /** 拼 hook 命令串（平台相关）。 */
  readonly command: (artifactPath: string, action: string) => string;
  /** 读产物内容用于判断「是不是本项目装的」。 */
  readonly artifactIsInstalled: (path: string) => boolean;
  /** 产物内容（脚本源码）。 */
  readonly artifactContent: () => string;
  readonly io: JsonHooksIo;
  readonly ops: JsonHooksShapeOps;
}

/** 用 `path.join` 语义拼路径（注入，避免本模块依赖 node:path）。 */
export type JoinPath = (...segments: string[]) => string;

export class JsonHooksInstaller {
  constructor(
    protected readonly layout: JsonHooksLayout,
    protected readonly deps: JsonHooksInstallerDeps,
    protected readonly join: JoinPath,
  ) {}

  configDir(): string | null {
    return this.deps.configDir();
  }

  artifactPath(): string | null {
    return this.deps.artifactPath();
  }

  version(): number | null {
    return this.deps.version();
  }

  isInstalled(): boolean {
    const path = this.artifactPath();
    return path !== null && this.deps.artifactIsInstalled(path);
  }

  // ---------------------------------------------------------------------------
  // 可覆写钩子 —— 子类只改这些，install/uninstall 骨架不要动
  // ---------------------------------------------------------------------------

  /**
   * 写产物之前的额外前置校验。抛错即中止安装（不留半安装）。
   *
   * 例：grok / antigravity / opencode 要求配置目录已存在（由各自 CLI 首次启动创建），
   * 桌面端主动建目录会造出一个 CLI 根本不认识的目录；
   * kimi 还要跑一次版本探测（异步），所以允许返回 Promise。
   */
  protected checkPreconditions(_dir: string): void | Promise<void> {
    /* 默认无前置条件 */
  }

  /**
   * 写产物时的目标子目录（相对 configDir；null = configDir 本身）。
   */
  protected artifactSubdir(): string | null {
    return this.layout.artifactSubdir;
  }

  /**
   * 通用 hooks 写入**之后**的额外注册动作。
   *
   * 例：codex 还要在 `config.toml` 打开 `hooks = true`；grok 写独占的
   * `herdr-desktop.json`；antigravity 写 `herdr-desktop` 独立块。
   */
  protected async registerExtra(
    _dir: string,
    _artifactPath: string,
    _configPath: string,
  ): Promise<void> {
    /* 默认无额外动作 */
  }

  /** 通用 hooks 摘除**之后**的额外反注册动作。 */
  protected async unregisterExtra(
    _dir: string,
    _artifactPath: string | null,
    _configPath: string,
  ): Promise<void> {
    /* 默认无额外动作 */
  }

  /**
   * 是否走「读取-修改-写回 hooks」的通用配置流程。
   *
   * 独占配置文件的智能体（grok）覆写为 false：它只写自己的 `herdr-desktop.json`，
   * 不该去碰共享的配置文件。
   */
  protected managesHooksConfig(): boolean {
    return true;
  }

  /**
   * 产物是否需要可执行位。
   *
   * hook 脚本需要（由 CLI 直接 exec）；插件/扩展不需要（由宿主 CLI 加载）。
   */
  protected needsExecutableBit(): boolean {
    return true;
  }

  /**
   * 卸载时是否删除产物**所在目录**而不是只删产物文件。
   *
   * 例：hermes 的插件是一个目录（含清单与入口），只删单个文件会留下空壳目录。
   */
  protected removesArtifactDirectory(): boolean {
    return false;
  }

  /** 模板方法：安装。差异走上面的钩子，子类不覆写本方法。 */
  async install(): Promise<void> {
    const dir = this.configDir();
    const artifact = this.artifactPath();
    if (!dir || !artifact) return;

    const configPath = this.join(dir, this.layout.configFile);

    // 1) 智能体私有的前置校验（目录必须已存在、版本闸门等）。先于任何写入。
    await this.checkPreconditions(dir);

    // 2) 预检配置目标：不可写就不要写产物，避免「脚本装了配置没改」的半安装。
    if (this.managesHooksConfig()) {
      this.deps.io.checkConfigTarget(configPath);
    }

    // 3) 写产物（+ 可执行位，仅 hook 脚本需要）。
    const subdir = this.artifactSubdir();
    await this.deps.io.ensureDir(subdir ? this.join(dir, subdir) : dir);
    await this.deps.io.writeArtifact(artifact, this.deps.artifactContent());
    if (this.needsExecutableBit()) {
      await this.deps.io.makeExecutable(artifact);
    }

    // 4) 通用 hooks 配置：先移除旧事件，再写入当前事件。
    if (this.managesHooksConfig()) {
      await this.writeHooksConfig(configPath, artifact);
    }

    // 5) 智能体私有的额外配置（TOML / 独占文件 / YAML）。
    await this.registerExtra(dir, artifact, configPath);
  }

  /** 模板方法：卸载（先摘登记，再删产物 —— 顺序不可颠倒）。 */
  async uninstall(): Promise<void> {
    const dir = this.configDir();
    const artifact = this.artifactPath();
    if (!dir) return;

    const configPath = this.join(dir, this.layout.configFile);

    // 1) 摘掉通用 hooks 登记。
    if (this.managesHooksConfig()) {
      await this.removeHooksConfig(configPath, artifact);
    }

    // 2) 摘掉智能体私有的额外登记。
    await this.unregisterExtra(dir, artifact, configPath);

    // 3) 删产物（插件类智能体可能是一个目录，交给 IO 处理）。
    await this.deps.io.removeArtifact(artifact ?? '');
    if (this.removesArtifactDirectory() && artifact) {
      // 主产物在目录里：删掉整个目录（含清单等附加文件）。
      await this.deps.io.removeDirectory?.(this.join(dir, this.artifactSubdir() ?? ''));
    }
  }

  private async writeHooksConfig(configPath: string, artifact: string): Promise<void> {
    const root = await this.deps.io.readJson(configPath);
    if (this.layout.withVersion && root.version === undefined) root.version = 1;
    const hooks = this.deps.ops.ensureHooksObject(root);

    for (const [event, action] of this.layout.removedEvents ?? []) {
      this.deps.ops.removeHook(hooks, event, this.deps.command(artifact, action));
    }
    for (const [event, action, eventOptions] of this.layout.events) {
      this.deps.ops.ensureHook(hooks, this.layout.shape, event, this.deps.command(artifact, action), {
        // 逐事件选项优先，其次回落到 layout 的全局默认。
        matcher: eventOptions?.matcher ?? this.layout.matcher,
        timeout: this.layout.timeout,
        quiet: this.layout.quiet,
        background: eventOptions?.background,
      });
    }
    await this.deps.io.writeJsonKey(configPath, 'hooks', root.hooks);
    if (this.layout.withVersion && root.version !== undefined) {
      await this.deps.io.writeJsonKey(configPath, 'version', root.version);
    }
  }

  private async removeHooksConfig(configPath: string, artifact: string | null): Promise<void> {
    const root = await this.deps.io.readJson(configPath);
    // 只在配置里本来就有 hooks 时才动它，避免给无相关的配置凭空加一个空 hooks 对象。
    const hooks = this.deps.ops.hooksObjectIfPresent(root);
    if (!hooks) return;

    let changed = false;
    for (const [event, action] of this.layout.events) {
      changed = this.deps.ops.removeHook(hooks, event, this.deps.command(artifact ?? '', action)) || changed;
    }
    for (const [event, action] of this.layout.removedEvents ?? []) {
      changed = this.deps.ops.removeHook(hooks, event, this.deps.command(artifact ?? '', action)) || changed;
    }
    if (changed) await this.deps.io.writeJsonKey(configPath, 'hooks', hooks);
  }
}
