/**
 * DeepSeek Harness 的集成安装器。
 *
 * `JsonHooksInstaller` 的子类。差异最大的一个：
 * - 产物是**一个自包含的 `.mjs` 插件**，不是 hook 脚本，也不需要可执行位；
 * - 注册位置是 `cordis.patch.yml` 里的一个块（YAML），不是 JSON hooks 数组；
 * - 因此不走通用 hooks 流程（`managesHooksConfig() === false`）。
 *
 * 安装位置用 Harness 全局 home（`$DSH_HOME`，默认 `~/.dsh`）而非某个 profile：
 * 插件是自包含、无依赖的单文件，未设置 `HERDR_DESKTOP_REPORT_URL` 时是 no-op，
 * 挂到 home 层不会影响任何非 Herdr 启动的 dsh 进程；home 层的 `cordis.patch.yml`
 * 也不属于 profile 自动初始化写入的文件，避免被 `dsh web` 首次启动覆盖。
 */

import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IntegrationInstaller } from '../installer';
import {
  JsonHooksInstaller,
  type JsonHooksInstallerDeps,
  type JsonHooksLayout,
  type JoinPath,
} from './json-hooks-installer';
import {
  declaredVersion,
  ensureHook,
  ensureHooksObject,
  hooksObjectIfPresent,
  jsonHooksIo,
  removeHook,
  scriptInstalled,
} from './kit';
import dshPlugin from '../assets/dsh/herdr-desktop-agent-state.mjs?raw';

/** 状态插件的文件名（带 `.mjs`，确保按 ESM 加载，与 profile 的 package.json 无关）。 */
export const DSH_STATUS_PLUGIN_NAME = 'herdr-desktop-agent-state.mjs';

/** `cordis.patch.yml` 里的块标记。 */
const DSH_PATCH_BEGIN = '# >>> herdr dsh integration';
const DSH_PATCH_END = '# <<< herdr dsh integration';

/** dsh 需要的额外 IO：YAML 块的新增/删除。 */
export interface DshInstallerIo {
  /** 在 `cordis.patch.yml` 里 upsert 我们的块。 */
  upsertPatch(patchPath: string): Promise<void>;
  /** 从 `cordis.patch.yml` 里移除我们的块（幂等）。 */
  removePatchBlock(patchPath: string): Promise<void>;
}

/**
 * 判断 `cordis.patch.yml` 的内容里我们的块是否**仍是 dsh 能吃的形态**。
 *
 * 产物存在且版本够、但注册块写坏时，通用三步会误判成 `installed` ——
 * 用户看不到「需要更新」，也就没有入口触发修复。这里把这种情形暴露出来，
 * 让 `hookStatuses()` 报 `outdated`，装一次即修好。
 */
export function dshPatchBlockIsValid(content: string): boolean {
  const begin = content.indexOf(DSH_PATCH_BEGIN);
  const end = content.indexOf(DSH_PATCH_END);
  if (begin < 0 || end < 0 || end < begin) return false;
  const block = content.slice(begin, end);
  return (
    block.includes('- insert:') &&
    !block.includes('- patch:') &&
    /- id:\s*\S+/.test(block) &&
    /name:\s*\.\/plugins\//.test(block)
  );
}

export class DshInstaller extends JsonHooksInstaller {
  constructor(
    layout: JsonHooksLayout,
    deps: JsonHooksInstallerDeps,
    join: JoinPath,
    private readonly dsh: DshInstallerIo,
  ) {
    super(layout, deps, join);
  }

  /** 注册在 YAML 块里，不走 JSON hooks 流程。 */
  protected override managesHooksConfig(): boolean {
    return false;
  }

  /** 插件由 Node 直接加载，不需要可执行位（与 hook 脚本不同）。 */
  protected override needsExecutableBit(): boolean {
    return false;
  }

  /**
   * 「装好了但注册块已失效」判据。
   *
   * 三种情形分开处理，不能一律当有效：
   * - 不知道配置目录 → 无从判断，报有效（不误报）；
   * - 产物在但 `cordis.patch.yml` 不存在 → **无效**：注册块是产物的唯一生效途径，
   *   文件没了等同于没装，否则 `hookStatuses()` 会一直报 `installed`、用户没有修复入口；
   * - 文件在但读不出来（权限等）→ 报有效（保守：不因一次读失败就提示更新）；
   * - 读到内容 → 按 schema 判。
   */
  validate(): boolean {
    const dir = this.configDir();
    if (dir === null) return true;
    const path = this.join(dir, 'cordis.patch.yml');
    if (!existsSync(path)) return false;
    const content = readTextSyncSafe(path);
    if (content === null) return true;
    return dshPatchBlockIsValid(content);
  }

  /** 产物已由基类写入；这里补 `cordis.patch.yml` 的块。 */
  protected override async registerExtra(
    dir: string,
    _artifactPath: string,
    _configPath: string,
  ): Promise<void> {
    await this.dsh.upsertPatch(this.join(dir, 'cordis.patch.yml'));
  }

  /** 先摘 YAML 块（产物由基类删除）。 */
  protected override async unregisterExtra(
    dir: string,
    _artifactPath: string | null,
    _configPath: string,
  ): Promise<void> {
    await this.dsh.removePatchBlock(this.join(dir, 'cordis.patch.yml'));
  }
}

/**
 * `cordis.patch.yml` 里插入的块内容。
 *
 * 形态由 dsh 的 patch 解析器（`dsh-app-boot: parsePatchList` +
 * `anchorInsertedPluginNames`）决定，不是自由格式：
 *
 * - 顶层必须是 **PatchOptions 数组**，每项自己持有 `insert`；
 * - `insert` 的每个条目必须是**带 `name` 的映射**，`name` 用 `./` 相对路径
 *   （解析器只把 `./` / `../` / 绝对路径转成 file URL）；
 * - 不能多包一层 `patch:` —— 那样顶层项就没有 `insert`，整块被静默忽略。
 *
 * 忽略的后果不是报错而是「插件根本没加载」：状态上报全部消失，且
 * `register-workspace` 路由不存在，主进程拿不到落地会话 id。
 */
export function dshPatchBlock(): string {
  return [
    DSH_PATCH_BEGIN,
    '- insert:',
    '    - id: herdr-desktop-agent-state',
    `      name: ./plugins/${DSH_STATUS_PLUGIN_NAME}`,
    DSH_PATCH_END,
  ].join('\n');
}

/** 纯函数版：从内容里删掉块标记区间。 */
export function removeDshPatchBlockFrom(content: string): string {
  const begin = content.indexOf(DSH_PATCH_BEGIN);
  if (begin < 0) return content;
  const end = content.indexOf(DSH_PATCH_END);
  const after = end >= 0 ? end + DSH_PATCH_END.length : content.length;
  return (content.slice(0, begin) + content.slice(after)).replace(/\n{3,}/g, '\n\n');
}

/** 读文本（不存在返回空串）。 */
async function readTextSafe(path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/** 同步读文本；读失败返回 null（区别于「读到空文件」）。 */
function readTextSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** upsert：先移除旧块，再追加新块（保证重装同步最新内容）。 */
export async function upsertDshPatch(patchPath: string): Promise<void> {
  const content = await readTextSafe(patchPath);
  const stripped = removeDshPatchBlockFrom(content).replace(/\n+$/, '');
  const next = stripped.length > 0 ? `${stripped}\n\n${dshPatchBlock()}\n` : `${dshPatchBlock()}\n`;
  await fs.writeFile(patchPath, next, 'utf8');
}

/** 从 `cordis.patch.yml` 里移除我们的块（无则 no-op）。 */
export async function removeDshPatchBlock(patchPath: string): Promise<void> {
  const content = await readTextSafe(patchPath);
  const next = removeDshPatchBlockFrom(content);
  if (next !== content) await fs.writeFile(patchPath, next, 'utf8');
}

/** 创建 dsh 的集成安装器。 */
export function createDshTarget(): IntegrationInstaller {
  const homeDir = (): string => {
    const home = process.env.DSH_HOME?.trim();
    return home ? home : join(homedir(), '.dsh');
  };
  const pluginPath = (): string => join(homeDir(), 'plugins', DSH_STATUS_PLUGIN_NAME);

  return new DshInstaller(
    {
      // 注册在 YAML 块里，configFile 只用于与其它智能体同构（不会被通用流程读写）。
      configFile: 'cordis.patch.yml',
      shape: 'nested',
      event: 'SessionStart',
      events: [],
      artifactSubdir: 'plugins',
    },
    {
      configDir: homeDir,
      artifactPath: pluginPath,
      version: () => declaredVersion('dsh'),
      // dsh 不走 hooks 命令，占位实现即可。
      command: () => '',
      artifactIsInstalled: (path) => scriptInstalled(path),
      artifactContent: () => dshPlugin,
      io: jsonHooksIo(),
      ops: { ensureHooksObject, hooksObjectIfPresent, ensureHook, removeHook },
    },
    join,
    {
      upsertPatch: (path) => upsertDshPatch(path),
      removePatchBlock: (path) => removeDshPatchBlock(path),
    },
  );
}
