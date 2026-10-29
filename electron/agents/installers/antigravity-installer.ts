/**
 * Antigravity CLI 的集成安装器 —— `JsonHooksInstaller` 的第三个子类。
 *
 * 两处与声明式智能体的差异：
 * 1. **目录必须已存在**（由 antigravity cli 首次启动创建），桌面端不主动建；
 * 2. 不注册到共享的 `hooks` 数组，而是写一个**独立块** `herdr-desktop`，
 *    这样和用户自己的 hook 完全互不干扰。
 *
 * 事件语义（写在这里而不是散在安装函数里）：
 * - `PreInvocation`：每轮模型调用开始 → 上报 working，用来「夹住」整轮；
 * - `Stop`：本轮结束 → 仅当 payload 的 fullyIdle 为 true 才上报 idle。
 * 只有 Stop+fullyIdle 会产生 working→idle 跳变，所以「初始化完成」和
 * 「工具跑完」都不再触发完成提示音（屏幕检测分不清这三者）。
 */

import { JsonHooksInstaller } from './json-hooks-installer';
import type { JsonHooksInstallerDeps, JsonHooksLayout, JoinPath } from './json-hooks-installer';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { isWindows } from '../../platform';
import type { IntegrationInstaller } from '../installer';
import { HOOK_SCRIPT_NAME, commandFor, declaredVersion, ensureHook, ensureHooksObject, envOrHome, hooksObjectIfPresent, jsonHooksIo, readJson, removeHook, removeJsonKey, scriptInstalled, writeJsonKey } from './kit';
import antigravitySh from '../assets/antigravity/herdr-desktop-agent-state.sh?raw';
import antigravityPs1 from '../assets/antigravity/herdr-desktop-agent-state.ps1?raw';

/** antigravity 写进 hooks.json 的独立块键名。 */
export const ANTIGRAVITY_BLOCK_KEY = 'herdr-desktop';

/** antigravity 需要的额外 IO。 */
export interface AntigravityInstallerIo {
  isDirectory(path: string): boolean;
  /** 读 hooks.json（不存在返回空对象）。 */
  readJson(path: string): Promise<Record<string, any>>;
  /** 读 hooks.json（不存在返回空对象），用于卸载前的存在性探测。 */
  readJson(path: string): Promise<Record<string, any>>;
  /** 精确写入一个顶层键，保留用户其它键与注释。 */
  writeJsonKey(path: string, key: string, value: unknown): Promise<void>;
  /** 删掉一个顶层键，保留其余内容。 */
  removeJsonKey(path: string, key: string): Promise<void>;
  command(artifactPath: string, action: string): string;
}

export class AntigravityInstaller extends JsonHooksInstaller {
  constructor(
    layout: JsonHooksLayout,
    deps: JsonHooksInstallerDeps,
    join: JoinPath,
    private readonly antigravity: AntigravityInstallerIo,
  ) {
    super(layout, deps, join);
  }

  /** 写独立块，不参与共享 hooks 数组。 */
  protected override managesHooksConfig(): boolean {
    return false;
  }

  /** 配置目录必须已存在，否则给一个可读错误而不是造空目录。 */
  protected override checkPreconditions(dir: string): void {
    if (!this.antigravity.isDirectory(dir)) {
      throw new Error(
        `antigravity cli config directory not found at ${dir}. install antigravity cli first`,
      );
    }
  }

  /** 写 `herdr-desktop` 独立块（两个事件）。 */
  protected override async registerExtra(
    dir: string,
    artifactPath: string,
    _configPath: string,
  ): Promise<void> {
    const hooksPath = this.join(dir, 'hooks.json');
    /*
     * 用 writeJsonKey 精确改一个键，而不是 readJson + writeJson 整文件重写。
     * 后者会把用户的注释、键顺序、缩进全部重排 —— 对用户配置做无声重排是不可接受的。
     */
    await this.antigravity.writeJsonKey(hooksPath, ANTIGRAVITY_BLOCK_KEY, {
      PreInvocation: [
        { type: 'command', command: this.antigravity.command(artifactPath, 'session'), timeout: 10 },
      ],
      Stop: [
        { type: 'command', command: this.antigravity.command(artifactPath, 'stop'), timeout: 10 },
      ],
    });
  }
  /** 只删自己的块；没有就完全不写回，避免无改动时重排用户配置。 */
  protected override async unregisterExtra(
    dir: string,
    _artifactPath: string | null,
    _configPath: string,
  ): Promise<void> {
    const hooksPath = this.join(dir, 'hooks.json');
    // 先只读探测：没有我们的块时不写回，避免 modify 生成无意义的空编辑。
    const root = await this.antigravity.readJson(hooksPath);
    if (!(ANTIGRAVITY_BLOCK_KEY in root)) return;
    await this.antigravity.removeJsonKey(hooksPath, ANTIGRAVITY_BLOCK_KEY);
  }
}

/**
 * 创建 antigravity 的集成安装器。
 *
 * 放在智能体自己的文件里：独立块 `herdr-desktop`、目录预检、编码命令形态
 * 都只属于 antigravity。
 */
export function createAntigravityTarget(): IntegrationInstaller {
  const configDir = (): string | null =>
    envOrHome('ANTIGRAVITY_CLI_CONFIG_DIR', ['.gemini', 'config']);
  const artifactPath = (): string | null => {
    const dir = configDir();
    return dir ? join(dir, 'hooks', HOOK_SCRIPT_NAME) : null;
  };
  const encodedCommand = (path: string, action: string): string =>
    commandFor({ encodedCommand: true }, path, action);

  return new AntigravityInstaller(
    {
      configFile: 'hooks.json',
      shape: 'nested',
      event: 'PreInvocation',
      // 独立块由 registerExtra 整体写入；这里保留声明以便与其它智能体同构。
      events: [['PreInvocation', 'session'], ['Stop', 'stop']],
      artifactSubdir: 'hooks',
    },
    {
      configDir,
      artifactPath,
      version: () => declaredVersion('antigravity'),
      command: encodedCommand,
      artifactIsInstalled: (path) => scriptInstalled(path),
      artifactContent: () => (isWindows ? antigravityPs1 : antigravitySh),
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
      readJson: (path) => readJson(path),
      writeJsonKey: (path, key, value) => writeJsonKey(path, key, value),
      removeJsonKey: (path, key) => removeJsonKey(path, key),
      command: encodedCommand,
    },
  );
}

// ---------------------------------------------------------------------------
// grok —— ~/.grok/hooks/ 脚本 + herdr-desktop.json
// ---------------------------------------------------------------------------

/** grok 独占的 hook 配置文件名（相对 `hooks/` 目录）。 */
/** grok 配置目录：GROK_CONFIG_DIR 覆盖 → GROK_HOME → ~/.grok（对应 herdr grok_dir）。 */
