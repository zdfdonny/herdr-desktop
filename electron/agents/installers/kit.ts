/**
 * 集成安装的共享工具 —— 所有智能体的安装器都从这里取能力。
 *
 * 从 `electron/runtime/integration/index.ts` 抽出。它只含**与具体智能体无关**的东西：
 * - 路径解析（env 覆盖 + 家目录回退）
 * - hook 命令拼装（POSIX / PowerShell，含 -EncodedCommand 形态）
 * - JSON/JSONC 配置的读写（原子写、注释保留、重复键拒绝）
 * - 四种 hook 容器形状的增删（nested / flat / direct / simple）
 * - 产物判定（标记匹配）与可执行位
 *
 * 这样每个智能体的安装器可以放在自己的文件里（`electron/agents/integration/<agent>-installer.ts`），
 * 只依赖本模块，不会反向 import 汇总层造成循环。
 */

import { promises as fs, existsSync, readFileSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parse, parseTree, modify, applyEdits, type ParseError, type Node } from 'jsonc-parser';
import { isWindows } from '../../platform';
import { agentById } from '../../../shared/agents/registry';
import type { JsonHooksIo } from './json-hooks-installer';
import type { IntegrationInstaller } from '../installer';

export const INTEGRATION_ID = 'herdr-desktop';
export const HOOK_SCRIPT_NAME = isWindows ? 'herdr-desktop-agent-state.ps1' : 'herdr-desktop-agent-state.sh';
export function declaredVersion(agentId: string): number | null {
  return agentById(agentId)?.integration?.version ?? null;
}

export function homeJoin(...segments: string[]): string {
  return join(homedir(), ...segments);
}

export function envOrHome(envVar: string, fallbackSegments: string[]): string {
  const env = process.env[envVar];
  if (env && env.trim()) return expandTilde(env.trim());
  return homeJoin(...fallbackSegments);
}

export function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

export function hookCommand(path: string, action: string): string {
  return isWindows
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${path}" ${action}`
    : `bash '${path.replace(/'/g, `'\\''`)}' ${action}`;
}

export function powershellEncodedCommand(path: string, action: string): string {
  const script = `& '${path.replace(/'/g, "''")}' ${action}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

export function grokHookCommand(path: string): string {
  return isWindows
    ? hookCommand(path, 'session')
    : `sh '${path.replace(/'/g, `'\\''`)}' session`;
}

export function commandFor(opts: { encodedCommand?: boolean }, path: string, action: string): string {
  return opts.encodedCommand && isWindows
    ? powershellEncodedCommand(path, action)
    : hookCommand(path, action);
}

/** 读取 JSON（用 jsonc-parser 容忍 JSONC 注释与尾逗号）；解析失败、根非对象或存在重复键时抛错，避免静默覆盖用户配置。 */
export async function readJson(path: string): Promise<Record<string, any>> {
  const text = await readText(path);
  if (!text.trim()) return {};
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) {
    throw new Error(`failed to parse JSON config at ${path}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`JSON config at ${path} must be a JSON object`);
  }
  const tree = parseTree(text, [], { allowTrailingComma: true });
  if (tree) rejectDuplicateKeys(tree, path);
  return value as Record<string, any>;
}

/** 递归拒绝 JSON 对象中的重复键（对应 herdr claude_settings.rs reject_duplicate_keys）。 */
export function rejectDuplicateKeys(node: Node, path: string): void {
  if (node.type === 'object') {
    const names = new Set<string>();
    for (const prop of node.children ?? []) {
      if (prop.type === 'property') {
        const keyNode = prop.children?.[0];
        if (keyNode && keyNode.type === 'string' && typeof keyNode.value === 'string') {
          if (names.has(keyNode.value)) {
            throw new Error(`JSON config at ${path} contains duplicate key "${keyNode.value}"`);
          }
          names.add(keyNode.value);
        }
        const valueNode = prop.children?.[1];
        if (valueNode) rejectDuplicateKeys(valueNode, path);
      }
    }
  } else if (node.type === 'array') {
    for (const child of node.children ?? []) rejectDuplicateKeys(child, path);
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeConfigFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 用户配置写入前的安全预检：目标存在且非普通文件、或存在多个硬链接时抛错（对应 herdr check_config_target）。 */
export function checkConfigTarget(path: string): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!st.isFile()) {
    throw new Error(`cannot update ${path}: not a regular file`);
  }
  if (st.nlink > 1) {
    throw new Error(`cannot update ${path}: config has multiple hard links`);
  }
}

/** 若目标本身是符号链接，解析到真实路径（保留符号链接）；否则原样返回。 */
export function resolveConfigTarget(path: string): string {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      return realpathSync(path);
    }
  } catch {
    // 不存在或无法读取，原样返回
  }
  return path;
}

/** 原子写用户配置（临时文件 + rename，对应 herdr write_config）。 */
export async function writeConfigFile(path: string, contents: string): Promise<void> {
  checkConfigTarget(path);
  // 跟随符号链接写到真实目标，保留用户的符号链接。
  const target = resolveConfigTarget(path);
  const tmp = join(dirname(target), `.herdr-desktop-config-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(tmp, contents, 'utf8');
  try {
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 用 modify 仅改写 JSONC 文件的一个顶层键，保留其余键与其注释；value 为 undefined 时删除该键。 */
export async function writeJsonKey(path: string, key: string, value: unknown): Promise<void> {
  const text = await readText(path);
  if (!text.trim()) {
    await writeConfigFile(path, `${JSON.stringify({ [key]: value }, null, 2)}\n`);
    return;
  }
  const edits = modify(text, [key], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  await writeConfigFile(path, applyEdits(text, edits));
}

/**
 * 从 JSONC 文件里删掉一个顶层键，保留其余键、注释与格式。
 *
 * 与 writeJsonKey 分开命名是为了可读性：调用点写 `removeJsonKey(path, KEY)`
 * 比 `writeJsonKey(path, KEY, undefined)` 更清楚意图。
 */
export async function removeJsonKey(path: string, key: string): Promise<void> {
  await writeJsonKey(path, key, undefined);
}

export async function readText(path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 判断某个产物是否是「本项目装的」。
 *
 * 标记值本身带命名空间（`herdr-desktop`），因此也排除了上游 herdr 的脚本
 * 或 tui/v2 这类后缀变体被误判成本集成。
 */
export function scriptInstalled(path: string | null): boolean {
  if (!path || !existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').includes(`HERDR_DESKTOP_INTEGRATION_ID=${INTEGRATION_ID}`);
  } catch {
    return false;
  }
}

/** Unix 上把 hook 脚本设为可执行（对应 herdr make_executable；Windows 上为 no-op）。 */
export async function makeExecutable(path: string): Promise<void> {
  if (isWindows) return;
  try {
    await fs.chmod(path, 0o755);
  } catch {
    // 某些文件系统不支持 chmod，忽略
  }
}

// ---------------------------------------------------------------------------
// 通用 JSON hooks 结构（对应 herdr config_edit.rs）
// ---------------------------------------------------------------------------

export function ensureHooksObject(root: Record<string, any>): Record<string, any> {
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) {
    root.hooks = {};
  }
  return root.hooks;
}

/** 卸载时用：仅当 root.hooks 已是对象时返回它，否则返回 null（避免新建空 hooks）。 */
export function hooksObjectIfPresent(root: Record<string, any>): Record<string, any> | null {
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) return null;
  return root.hooks;
}

export function hookMatches(hook: any, command: string): boolean {
  return (
    hook &&
    typeof hook === 'object' &&
    (hook.command === command || hook.bash === command || hook.powershell === command)
  );
}

export function ensureNestedHook(
  hooks: Record<string, any>,
  event: string,
  command: string,
  opts: { matcher?: string; timeout?: number; quiet?: boolean; background?: boolean },
): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
  // 同一命令已存在时不重复插入；但若 async 形态与期望不符（例如从旧版本升级，
  // 旧版把这条事件装成了同步），就地修正，避免用户重装后仍然是阻塞式执行。
  //
  // 只在调用方**明确声明** background 时才纠正：多数调用方压根不传，若把它们一律
  // 当成 false，就会把用户手写的 `async: true` 抹掉——这个函数原本是「只增不改」的，
  // 不该因为一个 agent 的需求改变其它 agent 的语义。
  for (const entry of entries) {
    if (!Array.isArray(entry?.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!hookMatches(hook, command)) continue;
      if (opts.background !== undefined && Boolean(hook.async) !== opts.background) {
        if (opts.background) hook.async = true;
        else delete hook.async;
      }
      return;
    }
  }
  const invocation: Record<string, any> = { type: 'command', command };
  if (opts.timeout !== undefined) invocation.timeout = opts.timeout;
  if (opts.quiet) invocation.quiet = true;
  if (opts.background) invocation.async = true;
  const entry: Record<string, any> = { hooks: [invocation] };
  if (opts.matcher !== undefined) entry.matcher = opts.matcher;
  entries.push(entry);
}

export function ensureFlatHook(hooks: Record<string, any>, event: string, command: string, timeout: number): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
  if (entries.some((e: any) => hookMatches(e, command))) return;
  entries.push({ type: 'command', command, timeout: timeout, description: 'Report MastraCode agent state to Herdr' });
}

export function ensureDirectHook(hooks: Record<string, any>, event: string, command: string, timeout: number): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
  const field = isWindows ? 'powershell' : 'bash';
  if (entries.some((e: any) => hookMatches(e, command))) return;
  entries.push({ type: 'command', [field]: command, timeoutSec: timeout });
}

export function ensureSimpleHook(hooks: Record<string, any>, event: string, command: string): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
  if (entries.some((e: any) => e && e.command === command)) return;
  entries.push({ command });
}

/** hook 条目在配置里的容器形状。 */
export type JsonShape = 'nested' | 'flat' | 'direct' | 'simple';

export function ensureHook(
  hooks: Record<string, any>,
  shape: JsonShape,
  event: string,
  command: string,
  opts: { matcher?: string; timeout?: number; quiet?: boolean; background?: boolean },
): void {
  if (shape === 'nested') ensureNestedHook(hooks, event, command, opts);
  else if (shape === 'flat') ensureFlatHook(hooks, event, command, opts.timeout ?? 10);
  else if (shape === 'direct') ensureDirectHook(hooks, event, command, opts.timeout ?? 10);
  else ensureSimpleHook(hooks, event, command);
}

export function removeHook(hooks: Record<string, any>, event: string, command: string): boolean {
  const entries = hooks[event];
  if (!Array.isArray(entries)) return false;
  let removed = false;
  const next: any[] = [];
  for (const entry of entries) {
    if (entry && typeof entry === 'object' && Array.isArray(entry.hooks)) {
      const kept = entry.hooks.filter((h: any) => !hookMatches(h, command));
      if (kept.length !== entry.hooks.length) removed = true;
      if (kept.length > 0) next.push({ ...entry, hooks: kept });
    } else if (hookMatches(entry, command) || (entry && entry.command === command)) {
      removed = true;
    } else {
      next.push(entry);
    }
  }
  if (next.length === 0) delete hooks[event];
  else hooks[event] = next;
  return removed;
}

export function jsonHooksIo(): JsonHooksIo {
  return {
    checkConfigTarget: (path) => checkConfigTarget(path),
    ensureDir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => undefined),
    writeArtifact: (path, content) => fs.writeFile(path, content, 'utf8'),
    makeExecutable: (path) => makeExecutable(path),
    removeArtifact: async (path) => {
      await fs.rm(path, { force: true }).catch(() => undefined);
    },
    // 插件类智能体（hermes）的产物是一个目录，卸载时递归删除。
    removeDirectory: async (path) => {
      await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
    },
    readJson: (path) => readJson(path),
    writeJsonKey: (path: string, key: string, value: unknown) => writeJsonKey(path, key, value),
  };
}

/** 扩展/插件型安装器（写一个自包含文件，无配置注册）。 */
export function extensionTarget(opts: {
  configDir: () => string | null;
  asset: string;
  fileName: string;
  /** 该目录必须已存在（对应 herdr 各扩展/插件目录预检）。 */
  requireDir?: () => string | null;
  /** 错误提示里的 agent 名。 */
  agentLabel?: string;
}): IntegrationInstaller {
  return {
    configDir: opts.configDir,
    artifactPath() {
      const dir = this.configDir();
      return dir ? join(dir, opts.fileName) : null;
    },
    version: () => declaredVersion(opts.agentLabel ?? ''),
    isInstalled() {
      return scriptInstalled(this.artifactPath());
    },
    async install() {
      const dir = this.configDir();
      const path = this.artifactPath();
      if (!dir || !path) return;
      const required = opts.requireDir?.();
      if (required) {
        let isDir = false;
        try {
          isDir = statSync(required).isDirectory();
        } catch {
          isDir = false;
        }
        if (!isDir) {
          const label = opts.agentLabel ?? 'agent';
          throw new Error(`${label} directory not found at ${required}. install ${label} first`);
        }
      }
      /*
       * 建产物**所在目录**而不是 configDir：
       * kilo 的 fileName 是 `plugin/herdr-desktop-agent-state.js`，只 mkdir configDir
       * 会让 writeFile 因缺少 plugin/ 子目录而 ENOENT（安装必然失败）。
       * 用 dirname(path) + recursive 兼容任意深度的 fileName。
       */
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, opts.asset, 'utf8');
    },
    async uninstall() {
      await fs.rm(this.artifactPath() ?? '', { force: true }).catch(() => undefined);
    },
  };
}
