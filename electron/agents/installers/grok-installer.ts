/**
 * Grok CLI 的集成安装器 —— `JsonHooksInstaller` 的第一个子类。
 *
 * 它和声明式智能体的差异全在三个钩子上：
 * 1. **目录必须已存在**（由 grok cli 首次启动创建），桌面端不主动建；
 * 2. **写独占配置文件** `hooks/herdr-desktop.json`，而不是改用户共享的配置
 *    —— 这样卸载时只删自己的文件，不会碰用户手写的内容；
 * 3. 因此不走通用 hooks 流程（`managesHooksConfig() === false`）。
 */

import { JsonHooksInstaller } from './json-hooks-installer';
import type { JsonHooksInstallerDeps, JsonHooksLayout, JoinPath } from './json-hooks-installer';
import { join } from 'node:path';
import { promises as fs, readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isWindows } from '../../platform';
import type { IntegrationInstaller } from '../installer';
import { HOOK_SCRIPT_NAME, declaredVersion, ensureHook, ensureHooksObject, envOrHome, expandTilde, grokHookCommand, hooksObjectIfPresent, jsonHooksIo, removeHook, scriptInstalled, writeJson } from './kit';
import grokSh from '../assets/grok/herdr-desktop-agent-state.sh?raw';
import grokPs1 from '../assets/grok/herdr-desktop-agent-state.ps1?raw';

/** grok 独占的 hook 配置文件（相对 configDir）。 */
const GROK_CONFIG_FILE = 'herdr-desktop.json';

/** 目录是否已存在（不自动创建）。 */
export type DirectoryChecker = (path: string) => boolean;

/** grok 需要的额外 IO：目录探测 + 整文件写 / 删。 */
export interface GrokInstallerIo {
  isDirectory(path: string): boolean;
  /** 写整个 JSON 文件（独占文件，不需要保守的「只改一个键」）。 */
  writeJson(path: string, value: unknown): Promise<void>;
  /** 删除文件（不存在不报错）。 */
  removeFile(path: string): Promise<void>;
  /** 生成期望的 hook 配置内容。 */
  hookConfig(artifactPath: string): unknown;
  /** 实际配置是否与期望一致（漂移 → outdated）。 */
  configIsValid(): boolean;
}

export class GrokInstaller extends JsonHooksInstaller {
  constructor(
    layout: JsonHooksLayout,
    deps: JsonHooksInstallerDeps,
    join: JoinPath,
    private readonly grok: GrokInstallerIo,
  ) {
    super(layout, deps, join);
  }

  /** 独占配置文件，不走通用 hooks 流程。 */
  protected override managesHooksConfig(): boolean {
    return false;
  }

  /** 配置目录必须已存在，否则报一个可读错误而不是造一个空目录。 */
  protected override checkPreconditions(dir: string): void {
    if (!this.grok.isDirectory(dir)) {
      throw new Error(`grok config directory not found at ${dir}. install grok cli first`);
    }
  }

  /** 写 `hooks/herdr-desktop.json`（与产物同目录，但它是独立文件）。 */
  protected override async registerExtra(
    dir: string,
    artifactPath: string,
    _configPath: string,
  ): Promise<void> {
    await this.grok.writeJson(
      this.join(dir, 'hooks', GROK_CONFIG_FILE),
      this.grok.hookConfig(artifactPath),
    );
  }

  /** 删掉独占配置文件（产物由基类删除）。 */
  protected override async unregisterExtra(
    dir: string,
    _artifactPath: string | null,
    _configPath: string,
  ): Promise<void> {
    await this.grok.removeFile(this.join(dir, 'hooks', GROK_CONFIG_FILE));
  }

  /** 配置漂移校验：文件存在但内容与期望不符 → outdated。 */
  validate(): boolean {
    return this.grok.configIsValid();
  }
}
function grokDir(): string {
  const override = process.env.GROK_CONFIG_DIR?.trim();
  if (override) return expandTilde(override);
  return envOrHome('GROK_HOME', ['.grok']);
}

/** 生成 Herdr 独占的 grok hook 配置（对应 herdr grok_hook_config）。 */
export function grokHookConfig(path: string): Record<string, any> {
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: grokHookCommand(path), timeout: 10 }] }],
    },
  };
}

/** 校验 grok hook 配置是否与期望完全一致；漂移则视为需更新（对应 herdr grok_hook_config_is_valid）。 */
function grokHookConfigIsValid(): boolean {
  const dir = grokDir();
  const path = join(dir, 'hooks', HOOK_SCRIPT_NAME);
  let content: string;
  try {
    content = readFileSync(join(dir, 'hooks', 'herdr-desktop.json'), 'utf8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  return isDeepStrictEqual(parsed, grokHookConfig(path));
}

/**
 * grok —— 独占 `hooks/herdr-desktop.json`，不碰用户共享配置。
 *
 * 编排骨架复用 `GrokInstaller`（`JsonHooksInstaller` 的子类），
 * 这里只注入主进程的真实 IO 与 grok 私有的三项能力。
 */
/**
 * 创建 grok 的集成安装器。
 *
 * 放在智能体自己的文件里：独占配置文件 `hooks/herdr-desktop.json`、
 * 目录预检、配置漂移校验都只属于 grok。
 */
export function createGrokTarget(): IntegrationInstaller {
  const layout: JsonHooksLayout = {
    configFile: GROK_CONFIG_FILE,
    shape: 'nested',
    event: 'SessionStart',
    // 独占文件由 registerExtra 整体写入；这里保留事件声明以便与其它智能体同构。
    events: [['SessionStart', 'session']],
    artifactSubdir: 'hooks',
  };

  return new GrokInstaller(
    layout,
    {
      configDir: grokDir,
      artifactPath: () => {
        const dir = grokDir();
        return dir ? join(dir, 'hooks', HOOK_SCRIPT_NAME) : null;
      },
      version: () => declaredVersion('grok'),
      command: (path) => grokHookCommand(path),
      artifactIsInstalled: (path) => scriptInstalled(path),
      artifactContent: () => (isWindows ? grokPs1 : grokSh),
      io: jsonHooksIo(),
      ops: { ensureHooksObject, hooksObjectIfPresent, ensureHook, removeHook },
    },
    join,
    {
      isDirectory: (path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      },
      writeJson: (path, value) => writeJson(path, value as Record<string, any>),
      removeFile: async (path) => {
        await fs.rm(path, { force: true }).catch(() => undefined);
      },
      hookConfig: (artifactPath) => grokHookConfig(artifactPath),
      configIsValid: () => grokHookConfigIsValid(),
    },
  );
}

// ---------------------------------------------------------------------------
// 非 hook 集成（extension / plugin）
// ---------------------------------------------------------------------------
