/**
 * 官方集成安装器 —— 参考 herdr `src/integration/`。
 *
 * 覆盖两类集成：
 * - hook（脚本 + agent 配置注册）：claude、codex、kimi、copilot、devin、droid、
 *   qodercli、qwen、letta、cursor、mastracode、antigravity-cli、grok；
 * - 非 hook（extension/plugin）：pi、omp（扩展）、opencode、kilo（JS 插件）、
 *   hermes（Python 插件）。
 *
 * 每个智能体的脚本单独存放在 `assets/<agent>/` 文件夹里（见 `assets.ts`），
 * 对应 herdr `src/integration/assets/`。上报通道统一走本地 HTTP 上报端点
 * （`HERDR_DESKTOP_REPORT_URL`）。hook/资产都带 `HERDR_INTEGRATION_ID=herdr-desktop`
 * 标记，用于区分 herdr 官方集成与 herdr-desktop 集成。会话 id 与状态
 * （working/blocked/idle/done）都可上报，状态上报后该 pane 进入 hook 权威模式
 * （终端检测不再覆盖 status）。
 */

import { promises as fs, existsSync, readFileSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { parse, parseTree, modify, applyEdits, type ParseError, type Node } from 'jsonc-parser';
import { isWindows } from '../../platform';
import type { HookStatus } from '../../../shared/protocol';
import {
  PI_ASSET,
  OMP_ASSET,
  OPENCODE_ASSET,
  OPENCODE_TUI_SESSION_ASSET,
  OPENCODE_TUI_ASSET,
  KILO_ASSET,
  HERMES_PLUGIN_YAML,
  HERMES_PLUGIN_INIT,
  DSH_STATUS_PLUGIN,
  DSH_STATUS_PLUGIN_NAME,
  hookScriptContent,
  INTEGRATION_VERSIONS,
  type HookScriptAgent,
} from './assets';

const INTEGRATION_ID = 'herdr-desktop';
const HOOK_SCRIPT_NAME = isWindows ? 'herdr-desktop-agent-state.ps1' : 'herdr-desktop-agent-state.sh';
/** qwen / letta 用会话专用脚本名（对应 herdr 的 `*_HOOK_INSTALL_NAME`）。 */
const SESSION_SCRIPT_NAME = isWindows ? 'herdr-desktop-agent-session.ps1' : 'herdr-desktop-agent-session.sh';

/** 各智能体旧版事件（安装/卸载时一并移除，对应 herdr *_REMOVED_*_EVENTS）。 */

/** claude 旧版事件（对应 herdr claude_settings.rs HOOK_REMOVALS；SessionStart/session 单独处理）。 */
const CLAUDE_REMOVED_STATE_EVENTS: Array<[string, string]> = [
  ['PostToolUse', 'working'],
  ['PostToolUseFailure', 'working'],
  ['SubagentStop', 'working'],
  ['PermissionRequest', 'blocked'],
  ['SessionStart', 'idle'],
  ['UserPromptSubmit', 'working'],
  ['PreToolUse', 'working'],
  ['Stop', 'idle'],
  ['SessionEnd', 'release'],
];

/** devin 旧版事件（对应 herdr DEVIN_REMOVED_LIFECYCLE_HOOK_EVENTS）。 */
const DEVIN_REMOVED_STATE_EVENTS: Array<[string, string]> = [
  ['UserPromptSubmit', 'working'],
  ['PreToolUse', 'working'],
  ['PostToolUse', 'working'],
  ['PermissionRequest', 'blocked'],
  ['Stop', 'idle'],
  ['SessionEnd', 'release'],
];

/** droid 旧版事件（对应 herdr DROID_REMOVED_LIFECYCLE_HOOK_EVENTS）。 */
const DROID_REMOVED_STATE_EVENTS: Array<[string, string]> = [
  ['SessionStart', 'idle'],
  ['UserPromptSubmit', 'working'],
  ['PreToolUse', 'working'],
  ['PostToolUse', 'working'],
  ['Notification', 'blocked'],
  ['Stop', 'idle'],
  ['SubagentStop', 'working'],
  ['PreCompact', 'working'],
  ['SessionEnd', 'release'],
];

/** qodercli 旧版事件（对应 herdr QODERCLI_REMOVED_LIFECYCLE_HOOK_EVENTS）。 */
const QODERCLI_REMOVED_STATE_EVENTS: Array<[string, string]> = [
  ['SessionStart', 'idle'],
  ['UserPromptSubmit', 'working'],
  ['PreToolUse', 'working'],
  ['PostToolUse', 'working'],
  ['PostToolUseFailure', 'working'],
  ['SubagentStart', 'working'],
  ['SubagentStop', 'working'],
  ['PreCompact', 'working'],
  ['Notification', 'blocked'],
  ['PermissionRequest', 'blocked'],
  ['Stop', 'idle'],
  ['SessionEnd', 'release'],
];

/** mastracode 旧版事件（对应 herdr MASTRACODE_REMOVED_HOOK_EVENTS）。 */
const MASTRACODE_REMOVED_STATE_EVENTS: Array<[string, string]> = [
  ['SessionStart', 'idle'],
  ['SessionEnd', 'release'],
];

/** cursor 旧版 simple hooks（对应 herdr install_cursor 的移除列表，均用 session 命令）。 */
const CURSOR_REMOVED_SIMPLE_EVENTS: Array<[string, string]> = [
  ['beforeSubmitPrompt', 'session'],
  ['beforeShellExecution', 'session'],
  ['beforeMCPExecution', 'session'],
  ['stop', 'session'],
  ['sessionEnd', 'session'],
];

/** devin 的额外事件（对应 herdr DEVIN_HOOK_EVENTS）：每个事件都带会话引用。 */
const DEVIN_STATE_EVENTS: Array<[string, string]> = [
  ['UserPromptSubmit', 'session'],
  ['PreToolUse', 'session'],
  ['PostToolUse', 'session'],
  ['PermissionRequest', 'session'],
  ['Stop', 'session'],
];

/** mastracode 的额外事件（对应 herdr MASTRACODE_HOOK_EVENTS，除去 SessionStart）。 */
const MASTRACODE_STATE_EVENTS: Array<[string, string]> = [
  ['UserPromptSubmit', 'working'],
  ['AgentStart', 'working'],
  ['PreToolUse', 'working'],
  ['PermissionRequest', 'blocked'],
  ['PermissionResult', 'working'],
  ['SubagentStart', 'working'],
  ['SubagentEnd', 'working'],
  ['Interrupt', 'idle'],
  ['AgentEnd', 'idle'],
  ['Stop', 'idle'],
];

/** kimi 的事件集（对应 herdr KIMI_HOOK_EVENTS）：matcher 区分 AskUserQuestion。 */
const KIMI_ASK_USER_QUESTION_MATCHER = '^AskUserQuestion$';
const KIMI_OTHER_TOOL_MATCHER = '^(?!AskUserQuestion$).*$';
const KIMI_HOOK_EVENTS: Array<[event: string, matcher: string | null, action: string]> = [
  ['SessionStart', null, 'session'],
  ['UserPromptSubmit', null, 'working'],
  ['PreToolUse', KIMI_OTHER_TOOL_MATCHER, 'working'],
  ['PreToolUse', KIMI_ASK_USER_QUESTION_MATCHER, 'blocked'],
  ['PostToolUse', KIMI_ASK_USER_QUESTION_MATCHER, 'working'],
  ['PostToolUseFailure', KIMI_ASK_USER_QUESTION_MATCHER, 'working'],
  ['SubagentStart', null, 'working'],
  ['PreCompact', null, 'working'],
  ['PermissionRequest', null, 'blocked'],
  ['PermissionResult', null, 'working'],
  ['Stop', null, 'idle'],
  ['Interrupt', null, 'idle'],
];

const HOOK_TARGETS: Record<string, HookTarget> = {
  claude: claudeTarget(),
  codex: codexTarget(),
  kimi: kimiTarget(),
  copilot: jsonHooksTarget({
    agent: 'copilot',
    configDir: () => envOrHome('COPILOT_HOME', ['.copilot']),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: 'hooks',
    configFile: 'settings.json',
    event: 'SessionStart',
    shape: 'direct',
    timeout: 10,
  }),
  devin: jsonHooksTarget({
    agent: 'devin',
    configDir: () => devinDir(),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: null,
    configFile: 'config.json',
    event: 'SessionStart',
    shape: 'nested',
    timeout: 10,
    stateEvents: DEVIN_STATE_EVENTS,
    removedEvents: DEVIN_REMOVED_STATE_EVENTS,
  }),
  droid: jsonHooksTarget({
    agent: 'droid',
    configDir: () => homeJoin('.factory'),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: 'hooks',
    configFile: 'settings.json',
    event: 'SessionStart',
    shape: 'nested',
    timeout: 10,
    removedEvents: DROID_REMOVED_STATE_EVENTS,
  }),
  qodercli: jsonHooksTarget({
    agent: 'qodercli',
    configDir: () => envOrHome('QODER_CONFIG_DIR', ['.qoder']),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: 'hooks',
    configFile: 'settings.json',
    event: 'SessionStart',
    shape: 'nested',
    matcher: '*',
    timeout: 10,
    removedEvents: QODERCLI_REMOVED_STATE_EVENTS,
  }),
  qwen: jsonHooksTarget({
    agent: 'qwen',
    configDir: () => envOrHome('QWEN_HOME', ['.qwen']),
    scriptName: SESSION_SCRIPT_NAME,
    scriptSubdir: 'hooks',
    configFile: 'settings.json',
    event: 'SessionStart',
    shape: 'nested',
    matcher: '*',
    timeout: 10000,
  }),
  letta: jsonHooksTarget({
    agent: 'letta',
    configDir: () => homeJoin('.letta'),
    scriptName: SESSION_SCRIPT_NAME,
    scriptSubdir: 'hooks',
    configFile: 'settings.json',
    event: 'SessionStart',
    shape: 'nested',
    timeout: 10000,
    quiet: true,
  }),
  cursor: jsonHooksTarget({
    agent: 'cursor',
    configDir: () => envOrHome('CURSOR_CONFIG_DIR', ['.cursor']),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: null,
    configFile: 'hooks.json',
    event: 'sessionStart',
    shape: 'simple',
    withVersion: true,
    removedEvents: CURSOR_REMOVED_SIMPLE_EVENTS,
  }),
  mastracode: jsonHooksTarget({
    agent: 'mastracode',
    configDir: () => homeJoin('.mastracode'),
    scriptName: HOOK_SCRIPT_NAME,
    scriptSubdir: 'hooks',
    configFile: 'hooks.json',
    event: 'SessionStart',
    shape: 'flat',
    timeout: 10000,
    stateEvents: MASTRACODE_STATE_EVENTS,
    removedEvents: MASTRACODE_REMOVED_STATE_EVENTS,
    encodedCommand: true,
  }),
  antigravity: antigravityTarget(),
  grok: grokTarget(),
  // 非 hook 集成（extension / plugin）
  pi: piTarget(),
  omp: ompTarget(),
  opencode: opencodeTarget(),
  kilo: kiloTarget(),
  hermes: hermesTarget(),
  'dsh-web': dshWebTarget(),
};

export function hookStatuses(): Record<string, HookStatus> {
  const result: Record<string, HookStatus> = {};
  for (const [id, target] of Object.entries(HOOK_TARGETS)) {
    if (!target.isInstalled()) {
      result[id] = 'not-installed';
      continue;
    }
    const version = readInstalledVersion(target.hookPath());
    const expected = INTEGRATION_VERSIONS[id];
    result[id] = version !== null && expected !== undefined && version < expected ? 'outdated' : 'installed';
  }
  // opencode：主插件文件存在但 TUI/V2 注册失效时，按 herdr 记为 outdated 而非 installed。
  if (result.opencode === 'installed' && !opencodeTuiIntegrationIsValid()) {
    result.opencode = 'outdated';
  }
  // grok：脚本文件存在但 herdr-desktop.json 配置漂移时，按 herdr 记为 outdated。
  if (result.grok === 'installed' && !grokHookConfigIsValid()) {
    result.grok = 'outdated';
  }
  return result;
}

/** 读取已安装资产里的版本标记；读不到时返回 null。 */
function readInstalledVersion(path: string | null): number | null {
  if (!path) return null;
  try {
    const content = readFileSync(path, 'utf8');
    const match = content.match(/HERDR_INTEGRATION_VERSION=(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export async function installHook(agentId: string, reportUrl: string): Promise<HookStatus> {
  const target = HOOK_TARGETS[agentId];
  if (!target) return 'unsupported';
  await target.install(reportUrl);
  return target.isInstalled() ? 'installed' : 'not-installed';
}

export async function uninstallHook(agentId: string): Promise<HookStatus> {
  const target = HOOK_TARGETS[agentId];
  if (!target) return 'unsupported';
  await target.uninstall();
  return target.isInstalled() ? 'installed' : 'not-installed';
}

// ---------------------------------------------------------------------------
// 类型与通用工具
// ---------------------------------------------------------------------------

interface HookTarget {
  configDir(): string | null;
  hookPath(): string | null;
  isInstalled(): boolean;
  install(reportUrl: string): Promise<void>;
  uninstall(): Promise<void>;
}

type JsonShape = 'nested' | 'flat' | 'direct' | 'simple';

interface JsonHooksTargetOptions {
  agent: HookScriptAgent;
  configDir: () => string | null;
  scriptName: string;
  scriptSubdir: string | null;
  configFile: string;
  event: string;
  shape: JsonShape;
  matcher?: string;
  /** hook 执行超时；claude/codex/copilot 等以秒计，qwen/letta/mastracode 以毫秒计（herdr 写 10000）。 */
  timeout?: number;
  quiet?: boolean;
  withVersion?: boolean;
  stateEvents?: Array<[string, string]>;
  /** 旧版事件（安装/卸载时一并移除，对应 herdr *_REMOVED_*_EVENTS）。 */
  removedEvents?: Array<[string, string]>;
  encodedCommand?: boolean;
}

function homeJoin(...segments: string[]): string {
  return join(homedir(), ...segments);
}

function envOrHome(envVar: string, fallbackSegments: string[]): string {
  const env = process.env[envVar];
  if (env && env.trim()) return expandTilde(env.trim());
  return homeJoin(...fallbackSegments);
}

function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

function devinDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return expandTilde(join(xdg.trim(), 'devin'));
  if (isWindows) {
    const appdata = process.env.APPDATA;
    if (appdata && appdata.trim()) return join(appdata.trim(), 'devin');
  }
  return homeJoin('.config', 'devin');
}

function hookCommand(path: string, action: string): string {
  return isWindows
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${path}" ${action}`
    : `bash '${path.replace(/'/g, `'\\''`)}' ${action}`;
}

function powershellEncodedCommand(path: string, action: string): string {
  const script = `& '${path.replace(/'/g, "''")}' ${action}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

function grokHookCommand(path: string): string {
  return isWindows
    ? hookCommand(path, 'session')
    : `sh '${path.replace(/'/g, `'\\''`)}' session`;
}

function commandFor(opts: { encodedCommand?: boolean }, path: string, action: string): string {
  return opts.encodedCommand && isWindows
    ? powershellEncodedCommand(path, action)
    : hookCommand(path, action);
}

/** 读取 JSON（用 jsonc-parser 容忍 JSONC 注释与尾逗号）；解析失败、根非对象或存在重复键时抛错，避免静默覆盖用户配置。 */
async function readJson(path: string): Promise<Record<string, any>> {
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
function rejectDuplicateKeys(node: Node, path: string): void {
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeConfigFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 用户配置写入前的安全预检：目标存在且非普通文件、或存在多个硬链接时抛错（对应 herdr check_config_target）。 */
function checkConfigTarget(path: string): void {
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
function resolveConfigTarget(path: string): string {
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
async function writeConfigFile(path: string, contents: string): Promise<void> {
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
async function writeJsonKey(path: string, key: string, value: unknown): Promise<void> {
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

async function readText(path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function scriptInstalled(path: string | null): boolean {
  if (!path || !existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').includes(`HERDR_INTEGRATION_ID=${INTEGRATION_ID}`);
  } catch {
    return false;
  }
}

/** Unix 上把 hook 脚本设为可执行（对应 herdr make_executable；Windows 上为 no-op）。 */
async function makeExecutable(path: string): Promise<void> {
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

function ensureHooksObject(root: Record<string, any>): Record<string, any> {
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) {
    root.hooks = {};
  }
  return root.hooks;
}

/** 卸载时用：仅当 root.hooks 已是对象时返回它，否则返回 null（避免新建空 hooks）。 */
function hooksObjectIfPresent(root: Record<string, any>): Record<string, any> | null {
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) return null;
  return root.hooks;
}

function hookMatches(hook: any, command: string): boolean {
  return (
    hook &&
    typeof hook === 'object' &&
    (hook.command === command || hook.bash === command || hook.powershell === command)
  );
}

function ensureNestedHook(
  hooks: Record<string, any>,
  event: string,
  command: string,
  opts: { matcher?: string; timeout?: number; quiet?: boolean },
): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
  if (entries.some((e: any) => Array.isArray(e.hooks) && e.hooks.some((h: any) => hookMatches(h, command)))) {
    return;
  }
  const invocation: Record<string, any> = { type: 'command', command };
  if (opts.timeout !== undefined) invocation.timeout = opts.timeout;
  if (opts.quiet) invocation.quiet = true;
  const entry: Record<string, any> = { hooks: [invocation] };
  if (opts.matcher !== undefined) entry.matcher = opts.matcher;
  entries.push(entry);
}

function ensureFlatHook(hooks: Record<string, any>, event: string, command: string, timeout: number): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
  if (entries.some((e: any) => hookMatches(e, command))) return;
  entries.push({ type: 'command', command, timeout: timeout, description: 'Report MastraCode agent state to Herdr' });
}

function ensureDirectHook(hooks: Record<string, any>, event: string, command: string, timeout: number): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
  const field = isWindows ? 'powershell' : 'bash';
  if (entries.some((e: any) => hookMatches(e, command))) return;
  entries.push({ type: 'command', [field]: command, timeoutSec: timeout });
}

function ensureSimpleHook(hooks: Record<string, any>, event: string, command: string): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
  if (entries.some((e: any) => e && e.command === command)) return;
  entries.push({ command });
}

function ensureHook(
  hooks: Record<string, any>,
  shape: JsonShape,
  event: string,
  command: string,
  opts: { matcher?: string; timeout?: number; quiet?: boolean },
): void {
  if (shape === 'nested') ensureNestedHook(hooks, event, command, opts);
  else if (shape === 'flat') ensureFlatHook(hooks, event, command, opts.timeout ?? 10);
  else if (shape === 'direct') ensureDirectHook(hooks, event, command, opts.timeout ?? 10);
  else ensureSimpleHook(hooks, event, command);
}

function removeHook(hooks: Record<string, any>, event: string, command: string): boolean {
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

// ---------------------------------------------------------------------------
// 通用 settings.json / config.json / hooks.json 型 target
// ---------------------------------------------------------------------------

function jsonHooksTarget(opts: JsonHooksTargetOptions): HookTarget {
  const events: Array<[string, string]> = [[opts.event, 'session'], ...(opts.stateEvents ?? [])];
  return {
    configDir: opts.configDir,
    hookPath() {
      const dir = this.configDir();
      if (!dir) return null;
      return opts.scriptSubdir ? join(dir, opts.scriptSubdir, opts.scriptName) : join(dir, opts.scriptName);
    },
    isInstalled() {
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      // 写资产前先预检配置目标（对应 herdr check_config_targets）。
      checkConfigTarget(join(dir, opts.configFile));
      const scriptDir = opts.scriptSubdir ? join(dir, opts.scriptSubdir) : dir;
      await fs.mkdir(scriptDir, { recursive: true });
      await fs.writeFile(path, hookScriptContent(opts.agent, isWindows), 'utf8');
      await makeExecutable(path);

      const configPath = join(dir, opts.configFile);
      const root = await readJson(configPath);
      if (opts.withVersion && root.version === undefined) root.version = 1;
      const hooks = ensureHooksObject(root);
      // 先移除旧版事件，再写入新事件（对应 herdr *_REMOVED_*_EVENTS）。
      for (const [event, action] of opts.removedEvents ?? []) {
        removeHook(hooks, event, commandFor(opts, path, action));
      }
      for (const [event, action] of events) {
        const command = commandFor(opts, path, action);
        ensureHook(hooks, opts.shape, event, command, {
          matcher: opts.matcher,
          timeout: opts.timeout,
          quiet: opts.quiet,
        });
      }
      await writeJsonKey(configPath, 'hooks', root.hooks);
      if (opts.withVersion && root.version !== undefined) {
        await writeJsonKey(configPath, 'version', root.version);
      }
    },
    async uninstall() {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir) return;
      const configPath = join(dir, opts.configFile);
      const root = await readJson(configPath);
      const hooks = hooksObjectIfPresent(root);
      if (hooks) {
        let changed = false;
        for (const [event, action] of events) {
          changed = removeHook(hooks, event, commandFor(opts, path ?? '', action)) || changed;
        }
        for (const [event, action] of opts.removedEvents ?? []) {
          changed = removeHook(hooks, event, commandFor(opts, path ?? '', action)) || changed;
        }
        if (changed) await writeJsonKey(configPath, 'hooks', hooks);
      }
      await fs.rm(path ?? '', { force: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// claude —— ~/.claude/settings.json（SessionStart，session-only）
// ---------------------------------------------------------------------------

/** claude SessionStart 的 matcher（对应 herdr SESSION_START_MATCHER）。 */
const CLAUDE_SESSION_START_MATCHER = '^(startup|resume|clear|compact|fork)$';

function claudeTarget(): HookTarget {
  return {
    configDir: () => envOrHome('CLAUDE_CONFIG_DIR', ['.claude']),
    hookPath() {
      const dir = this.configDir();
      return dir ? join(dir, 'hooks', HOOK_SCRIPT_NAME) : null;
    },
    isInstalled() {
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      // 写资产前先预检配置目标（对应 herdr check_config_targets）。
      checkConfigTarget(join(dir, 'settings.json'));
      await fs.mkdir(join(dir, 'hooks'), { recursive: true });
      await fs.writeFile(path, hookScriptContent('claude', isWindows), 'utf8');
      await makeExecutable(path);

      const settingsPath = join(dir, 'settings.json');
      const settings = await readJson(settingsPath);
      const hooks = ensureHooksObject(settings);
      // 先移除旧版（startup/resume 两条 SessionStart + 旧版生命周期事件），
      // 再写入 herdr 的 session-only 版本。
      removeHook(hooks, 'SessionStart', hookCommand(path, 'session'));
      for (const [event, action] of CLAUDE_REMOVED_STATE_EVENTS) {
        removeHook(hooks, event, hookCommand(path, action));
      }
      ensureNestedHook(hooks, 'SessionStart', hookCommand(path, 'session'), {
        matcher: CLAUDE_SESSION_START_MATCHER,
        timeout: 10,
      });
      await writeJsonKey(settingsPath, 'hooks', settings.hooks);
    },
    async uninstall() {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir) return;
      const settingsPath = join(dir, 'settings.json');
      const settings = await readJson(settingsPath);
      const hooks = hooksObjectIfPresent(settings);
      if (hooks) {
        let changed = removeHook(hooks, 'SessionStart', hookCommand(path ?? '', 'session'));
        for (const [event, action] of CLAUDE_REMOVED_STATE_EVENTS) {
          changed = removeHook(hooks, event, hookCommand(path ?? '', action)) || changed;
        }
        if (changed) await writeJsonKey(settingsPath, 'hooks', hooks);
      }
      await fs.rm(path ?? '', { force: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// codex —— ~/.codex/hooks.json + config.toml
// ---------------------------------------------------------------------------

/** codex 状态事件（对应 herdr install_codex：UserPromptSubmit/Stop/Interrupt）。 */
const CODEX_STATE_EVENTS: Array<[string, string]> = [
  ['UserPromptSubmit', 'working'],
  ['Stop', 'idle'],
  ['Interrupt', 'idle'],
];
/** codex 旧版曾安装、现已移除的事件（对应 herdr install_codex 的移除列表）。 */
const CODEX_REMOVED_STATE_EVENTS: Array<[string, string]> = [
  ['SessionStart', 'idle'],
  ['PreToolUse', 'working'],
  ['PermissionRequest', 'blocked'],
];

function codexTarget(): HookTarget {
  return {
    configDir: () => envOrHome('CODEX_HOME', ['.codex']),
    hookPath() {
      const dir = this.configDir();
      return dir ? join(dir, HOOK_SCRIPT_NAME) : null;
    },
    isInstalled() {
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      // 写资产前先预检配置目标（对应 herdr check_config_targets）。
      checkConfigTarget(join(dir, 'hooks.json'));
      checkConfigTarget(join(dir, 'config.toml'));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path, hookScriptContent('codex', isWindows), 'utf8');
      await makeExecutable(path);

      const hooksPath = join(dir, 'hooks.json');
      const hooksRoot = await readJson(hooksPath);
      const hooks = ensureHooksObject(hooksRoot);
      // 先移除旧版 PreToolUse/PermissionRequest，再写入 herdr 的事件集。
      for (const [event, action] of CODEX_REMOVED_STATE_EVENTS) {
        removeHook(hooks, event, hookCommand(path, action));
      }
      ensureNestedHook(hooks, 'SessionStart', hookCommand(path, 'session'), { timeout: 10 });
      for (const [event, action] of CODEX_STATE_EVENTS) {
        ensureNestedHook(hooks, event, hookCommand(path, action), { timeout: 10 });
      }
      await writeJsonKey(hooksPath, 'hooks', hooksRoot.hooks);

      const configPath = join(dir, 'config.toml');
      const content = await readText(configPath);
      await writeConfigFile(configPath, codexConfigWithHook(content));
    },
    async uninstall() {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir) return;
      const hooksPath = join(dir, 'hooks.json');
      const hooksRoot = await readJson(hooksPath);
      const hooks = hooksObjectIfPresent(hooksRoot);
      if (hooks) {
        let changed = removeHook(hooks, 'SessionStart', hookCommand(path ?? '', 'session'));
        for (const [event, action] of CODEX_STATE_EVENTS) {
          changed = removeHook(hooks, event, hookCommand(path ?? '', action)) || changed;
        }
        for (const [event, action] of CODEX_REMOVED_STATE_EVENTS) {
          changed = removeHook(hooks, event, hookCommand(path ?? '', action)) || changed;
        }
        if (changed) await writeJsonKey(hooksPath, 'hooks', hooks);
      }
      await fs.rm(path ?? '', { force: true }).catch(() => undefined);
    },
  };
}

/** 解析 TOML 表头（如 [features]、[[hooks]]）；非表头行返回 null（对应 herdr toml_table_header）。 */
function tomlTableHeader(line: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('[')) return null;
  const isArrayTable = trimmed.startsWith('[[');
  const close = trimmed.indexOf(isArrayTable ? ']]' : ']');
  if (close < 0) return null;
  const headerEnd = close + (isArrayTable ? 2 : 1);
  const header = trimmed.slice(0, headerEnd);
  const rest = trimmed.slice(headerEnd).trimStart();
  if (rest && !rest.startsWith('#')) return null;
  return header;
}

/** 判断 TOML 行是否是 `key = ...`（对应 herdr is_toml_key）。 */
function isTomlKey(line: string, key: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('#') || !trimmed.startsWith(key)) return false;
  return trimmed.slice(key.length).trimStart().startsWith('=');
}

function codexConfigWithHook(content: string): string {
  // 对应 herdr build_codex_config_with_hooks：删除废弃的 codex_hooks，并在 [features] 段内设置 hooks = true。
  const trailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let inFeatures = false;
  let featuresHeaderIndex = -1;
  let hooksIndex = -1;
  const deprecated: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const header = tomlTableHeader(lines[i]);
    if (header !== null) {
      inFeatures = header === '[features]';
      if (inFeatures && featuresHeaderIndex < 0) featuresHeaderIndex = i;
      continue;
    }
    if (!inFeatures) continue;
    if (isTomlKey(lines[i], 'codex_hooks')) deprecated.push(i);
    else if (isTomlKey(lines[i], 'hooks')) hooksIndex = i;
  }

  if (hooksIndex >= 0) lines[hooksIndex] = 'hooks = true';
  for (let i = deprecated.length - 1; i >= 0; i -= 1) lines.splice(deprecated[i], 1);

  if (hooksIndex < 0) {
    if (featuresHeaderIndex >= 0) {
      lines.splice(featuresHeaderIndex + 1, 0, 'hooks = true');
    } else {
      let result = content.replace(/\r?\n$/, '');
      if (result) result += '\n\n';
      result += '[features]\nhooks = true';
      return `${result}\n`;
    }
  }

  const result = lines.join('\n');
  return trailingNewline || result === '' ? `${result}\n` : result;
}

// ---------------------------------------------------------------------------
// kimi —— ~/.kimi-code/config.toml 的 [[hooks]] 块
// ---------------------------------------------------------------------------

function kimiTarget(): HookTarget {
  const events = KIMI_HOOK_EVENTS;
  return {
    configDir: () => envOrHome('KIMI_CODE_HOME', ['.kimi-code']),
    hookPath() {
      const dir = this.configDir();
      return dir ? join(dir, 'hooks', HOOK_SCRIPT_NAME) : null;
    },
    isInstalled() {
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      await checkKimiVersion();
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      // 写资产前先预检配置目标（对应 herdr check_config_targets）。
      checkConfigTarget(join(dir, 'config.toml'));
      await fs.mkdir(join(dir, 'hooks'), { recursive: true });
      await fs.writeFile(path, hookScriptContent('kimi', isWindows), 'utf8');
      await makeExecutable(path);

      const configPath = join(dir, 'config.toml');
      const content = await readText(configPath);
      await writeConfigFile(configPath, kimiConfigWithHook(content, path, events));
    },
    async uninstall() {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir) return;
      const configPath = join(dir, 'config.toml');
      const content = await readText(configPath);
      await fs.writeFile(configPath, removeKimiBlock(content), 'utf8');
      await fs.rm(path ?? '', { force: true }).catch(() => undefined);
    },
  };
}

const KIMI_BLOCK_BEGIN = '# >>> herdr kimi integration';
const KIMI_BLOCK_END = '# <<< herdr kimi integration';

const execFileAsync = promisify(execFile);
const KIMI_MIN_VERSION = '0.14.0';

function extractVersionTriple(text: string): [number, number, number] | null {
  for (const token of text.split(/\s+/)) {
    const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(token);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  }
  return null;
}

function compareTriples(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * kimi 最低版本检查（对应 herdr enforce_agent_version）。
 * 无法探测或无法解析时放行（warning 分支）；太旧则抛错阻断安装。
 */
async function checkKimiVersion(): Promise<void> {
  let stdout: string;
  try {
    const result = await execFileAsync('kimi', ['--version'], { timeout: 5000 });
    stdout = result.stdout;
  } catch {
    return;
  }
  const found = extractVersionTriple(stdout);
  const required = extractVersionTriple(KIMI_MIN_VERSION);
  if (found && required && compareTriples(found, required) < 0) {
    throw new Error(
      `kimi ${found.join('.')} is too old: hooks require kimi ${KIMI_MIN_VERSION} or newer`,
    );
  }
}

function kimiConfigWithHook(
  content: string,
  hookPath: string,
  events: Array<[event: string, matcher: string | null, action: string]>,
): string {
  // 对应 herdr build_kimi_config_with_hooks：总是先移除旧块再重建，确保重装同步最新事件。
  let result = removeKimiBlock(content).replace(/\r?\n$/, '');
  if (result) result += '\n\n';
  const rows = [KIMI_BLOCK_BEGIN];
  for (const [event, matcher, action] of events) {
    rows.push('[[hooks]]', `event = "${event}"`);
    if (matcher) rows.push(`matcher = ${tomlString(matcher)}`);
    rows.push(`command = ${tomlString(hookCommand(hookPath, action))}`, 'timeout = 10', '');
  }
  rows.push(KIMI_BLOCK_END);
  return `${result}${rows.join('\n')}\n`;
}

function removeKimiBlock(content: string): string {
  const begin = content.indexOf(KIMI_BLOCK_BEGIN);
  const end = content.indexOf(KIMI_BLOCK_END);
  if (begin < 0) return content;
  const after = end >= 0 ? end + KIMI_BLOCK_END.length : content.length;
  return (content.slice(0, begin) + content.slice(after)).replace(/\n{3,}/g, '\n\n');
}

function tomlString(value: string): string {
  // 对应 herdr toml_basic_string：常用控制字符用短转义，其余用 \uXXXX。
  let result = '"';
  for (const ch of value) {
    switch (ch) {
      case '"': result += '\\"'; break;
      case '\\': result += '\\\\'; break;
      case '\b': result += '\\b'; break;
      case '\t': result += '\\t'; break;
      case '\n': result += '\\n'; break;
      case '\f': result += '\\f'; break;
      case '\r': result += '\\r'; break;
      default:
        if (ch <= '\u001f' || ch === '\u007f') {
          result += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
        } else {
          result += ch;
        }
    }
  }
  result += '"';
  return result;
}

// ---------------------------------------------------------------------------
// antigravity-cli（agy）—— ~/.gemini/config/hooks.json 的 "herdr" 块
// ---------------------------------------------------------------------------

function antigravityTarget(): HookTarget {
  return {
    configDir: () => envOrHome('ANTIGRAVITY_CLI_CONFIG_DIR', ['.gemini', 'config']),
    hookPath() {
      const dir = this.configDir();
      return dir ? join(dir, 'hooks', HOOK_SCRIPT_NAME) : null;
    },
    isInstalled() {
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      checkConfigTarget(join(dir, 'hooks.json'));
      // 对应 herdr install_antigravity_cli：配置目录必须已存在（由 antigravity cli 首次启动创建）。
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        throw new Error(`antigravity cli config directory not found at ${dir}. install antigravity cli first`);
      }
      await fs.mkdir(join(dir, 'hooks'), { recursive: true });
      await fs.writeFile(path, hookScriptContent('antigravity', isWindows), 'utf8');
      await makeExecutable(path);

      const hooksPath = join(dir, 'hooks.json');
      const root = await readJson(hooksPath);
      const command = commandFor({ encodedCommand: true }, path, 'session');
      root['herdr-desktop'] = { PreInvocation: [{ type: 'command', command, timeout: 10 }] };
      await writeJson(hooksPath, root);
    },
    async uninstall() {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir) return;
      const hooksPath = join(dir, 'hooks.json');
      const root = await readJson(hooksPath);
      // 对应 herdr：只有真正移除了 herdr 块才写回，避免无改动时重排用户配置。
      if ('herdr-desktop' in root) {
        delete root['herdr-desktop'];
        await writeJson(hooksPath, root);
      }
      await fs.rm(path ?? '', { force: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// grok —— ~/.grok/hooks/ 脚本 + herdr-desktop.json
// ---------------------------------------------------------------------------

/** grok 配置目录：GROK_CONFIG_DIR 覆盖 → GROK_HOME → ~/.grok（对应 herdr grok_dir）。 */
function grokDir(): string {
  const override = process.env.GROK_CONFIG_DIR?.trim();
  if (override) return expandTilde(override);
  return envOrHome('GROK_HOME', ['.grok']);
}

/** 生成 Herdr 独占的 grok hook 配置（对应 herdr grok_hook_config）。 */
function grokHookConfig(path: string): Record<string, any> {
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

function grokTarget(): HookTarget {
  return {
    configDir: grokDir,
    hookPath() {
      const dir = this.configDir();
      return dir ? join(dir, 'hooks', HOOK_SCRIPT_NAME) : null;
    },
    isInstalled() {
      // 与 herdr 一致：以脚本文件是否存在判定 not-installed；配置漂移由 hookStatuses 降级为 outdated。
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir || !path) return;
      // 对应 herdr install_grok：配置目录必须已存在（由 grok cli 首次启动创建）。
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        throw new Error(`grok config directory not found at ${dir}. install grok cli first`);
      }
      await fs.mkdir(join(dir, 'hooks'), { recursive: true });
      await fs.writeFile(path, hookScriptContent('grok', isWindows), 'utf8');
      await makeExecutable(path);
      await writeJson(join(dir, 'hooks', 'herdr-desktop.json'), grokHookConfig(path));
    },
    async uninstall() {
      const dir = this.configDir();
      const path = this.hookPath();
      if (!dir) return;
      await fs.rm(join(dir, 'hooks', 'herdr-desktop.json'), { force: true }).catch(() => undefined);
      await fs.rm(path ?? '', { force: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// 非 hook 集成（extension / plugin）
// ---------------------------------------------------------------------------

function extensionTarget(opts: {
  configDir: () => string | null;
  asset: string;
  fileName: string;
  /** 该目录必须已存在（对应 herdr 各扩展/插件目录预检）。 */
  requireDir?: () => string | null;
  /** 错误提示里的 agent 名。 */
  agentLabel?: string;
}): HookTarget {
  return {
    configDir: opts.configDir,
    hookPath() {
      const dir = this.configDir();
      return dir ? join(dir, opts.fileName) : null;
    },
    isInstalled() {
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      const dir = this.configDir();
      const path = this.hookPath();
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
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path, opts.asset, 'utf8');
    },
    async uninstall() {
      await fs.rm(this.hookPath() ?? '', { force: true }).catch(() => undefined);
    },
  };
}

function piTarget(): HookTarget {
  return extensionTarget({
    configDir: () => piExtensionDir(),
    asset: PI_ASSET,
    fileName: 'herdr-desktop-agent-state.ts',
    requireDir: () => {
      const d = piExtensionDir();
      return d ? dirname(d) : null;
    },
    agentLabel: 'pi',
  });
}

function ompTarget(): HookTarget {
  return extensionTarget({
    configDir: () => ompExtensionDir(),
    asset: OMP_ASSET,
    fileName: 'herdr-desktop-omp-agent-state.ts',
    requireDir: () => {
      const d = ompExtensionDir();
      return d ? dirname(d) : null;
    },
    agentLabel: 'omp',
  });
}

function piExtensionDir(): string | null {
  return join(envOrHome('PI_CODING_AGENT_DIR', ['.pi', 'agent']), 'extensions');
}

function ompExtensionDir(): string | null {
  // 对应 herdr omp_extension_dir：PI_CODING_AGENT_DIR 直接接 extensions（无 agent 段），
  // 否则用 PI_CONFIG_DIR/~/.omp 再接 agent/extensions。
  const piDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (piDir) return join(expandTilde(piDir), 'extensions');
  const base = expandTilde(process.env.PI_CONFIG_DIR?.trim() || homeJoin('.omp'));
  return join(base, 'agent', 'extensions');
}

// ---------------------------------------------------------------------------
// opencode —— ~/.config/opencode（V1 插件 + V2 TUI 插件）
// 对应 herdr opencode_config.rs 与 targets.rs 的 install_opencode/uninstall_opencode。
// ---------------------------------------------------------------------------

/** V1 server 插件（由 V1 从 plugins/ 目录自动加载，不写进任何配置文件）。 */
const OPENCODE_PLUGIN_INSTALL_NAME = 'herdr-desktop-agent-state.js';
/** V1 TUI 插件文件名与 tui.jsonc/tui.json 的注册 spec。 */
const OPENCODE_TUI_PLUGIN_INSTALL_NAME = 'herdr-desktop-tui-session.js';
const OPENCODE_TUI_PLUGIN_SPEC = './herdr-desktop-tui-session.js';
/** V2 TUI 插件目录与 cli.json 的注册 spec。 */
const OPENCODE_V2_TUI_PLUGIN_DIR = 'herdr-desktop-opencode';
const OPENCODE_V2_TUI_PLUGIN_SPEC = './herdr-desktop-opencode';

function opencodeConfigDir(): string {
  return homeJoin('.config', 'opencode');
}

function opencodePluginPath(): string {
  return join(opencodeConfigDir(), 'plugins', OPENCODE_PLUGIN_INSTALL_NAME);
}

function opencodeTuiPluginPath(): string {
  return join(opencodeConfigDir(), OPENCODE_TUI_PLUGIN_INSTALL_NAME);
}

function opencodeV2Dir(): string {
  return join(opencodeConfigDir(), OPENCODE_V2_TUI_PLUGIN_DIR);
}

function opencodeStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME?.trim();
  return xdg ? join(expandTilde(xdg), 'opencode') : homeJoin('.local', 'state', 'opencode');
}

/** opencode 插件数组项匹配：支持字符串、{package} 对象、[spec, opts] 元组（对应 herdr plugin_entry_matches）。 */
function pluginEntryMatches(entry: unknown, spec: string): boolean {
  if (typeof entry === 'string') return entry === spec;
  if (Array.isArray(entry)) return typeof entry[0] === 'string' && entry[0] === spec;
  if (entry && typeof entry === 'object') {
    return (entry as Record<string, any>).package === spec;
  }
  return false;
}

/** 同步解析 JSONC 文件为对象；文件缺失/解析失败/根非对象时返回 null。 */
function parseJsoncObject(path: string): Record<string, any> | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  if (!text.trim()) return {};
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) return null;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

/** 某个 JSONC 文件的数组键里是否已注册指定插件。 */
function pluginIsConfigured(path: string, key: string, spec: string): boolean {
  const root = parseJsoncObject(path);
  if (!root) return false;
  const list = root[key];
  return Array.isArray(list) && list.some((entry) => pluginEntryMatches(entry, spec));
}

/** tui.jsonc 或 tui.json 任一文件已注册 V1 TUI 插件。 */
function tuiPluginIsConfigured(dir: string, spec: string): boolean {
  return (
    pluginIsConfigured(join(dir, 'tui.jsonc'), 'plugin', spec) ||
    pluginIsConfigured(join(dir, 'tui.json'), 'plugin', spec)
  );
}

/** 安装/卸载前预检 plugin/plugins 列表必须为数组（对应 herdr validate_tui_plugin_config）。 */
function validateOpencodeConfig(dir: string): void {
  for (const [name, key] of [
    ['tui.jsonc', 'plugin'],
    ['tui.json', 'plugin'],
    ['cli.json', 'plugins'],
  ] as const) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    const errors: ParseError[] = [];
    const value = parse(text, errors, { allowTrailingComma: true }) as unknown;
    if (errors.length > 0) {
      throw new Error(`failed to parse OpenCode config at ${path}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`OpenCode config at ${path} must be a JSON object`);
    }
    const list = (value as Record<string, any>)[key];
    if (list !== undefined && !Array.isArray(list)) {
      throw new Error(`OpenCode config plugin list at ${path} must be an array`);
    }
  }
}

/** 在 JSONC 文件数组键里增删插件项，保留注释；清空后删除该键（对应 herdr add_plugin/remove_plugin）。 */
async function editPluginList(path: string, key: string, spec: string, add: boolean): Promise<boolean> {
  checkConfigTarget(path);
  const text = await readText(path);
  if (!text.trim()) {
    if (!add) return false;
    await writeConfigFile(path, `${JSON.stringify({ [key]: [spec] }, null, 2)}\n`);
    return true;
  }
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) {
    throw new Error(`failed to parse OpenCode config at ${path}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OpenCode config at ${path} must be a JSON object`);
  }
  const root = value as Record<string, any>;
  if (root[key] !== undefined && !Array.isArray(root[key])) {
    throw new Error(`OpenCode config plugin list at ${path} must be an array`);
  }
  const list = Array.isArray(root[key]) ? root[key] : [];
  const present = list.some((entry) => pluginEntryMatches(entry, spec));
  if (add === present) return false;
  const next = add ? [...list, spec] : list.filter((entry) => !pluginEntryMatches(entry, spec));
  const edits = modify(text, [key], next.length > 0 ? next : undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  await writeConfigFile(path, applyEdits(text, edits));
  return true;
}

/** 注册 V1 TUI 插件；tui.json 已注册则复用，否则写入 tui.jsonc（对应 herdr add_tui_plugin）。 */
async function addTuiPlugin(dir: string, spec: string): Promise<string> {
  for (const name of ['tui.jsonc', 'tui.json']) {
    const path = join(dir, name);
    if (pluginIsConfigured(path, 'plugin', spec)) return path;
  }
  const path = join(dir, 'tui.jsonc');
  await editPluginList(path, 'plugin', spec, true);
  return path;
}

/** 从 tui.jsonc 与 tui.json 移除 V1 TUI 插件注册（对应 herdr remove_tui_plugin）。 */
async function removeTuiPlugin(dir: string, spec: string): Promise<string[]> {
  const updated: string[] = [];
  const errors: string[] = [];
  for (const name of ['tui.jsonc', 'tui.json']) {
    try {
      if (await editPluginList(join(dir, name), 'plugin', spec, false)) {
        updated.push(join(dir, name));
      }
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
  return updated;
}

/** OpenCode 首次 V2 启动会把 V1 配置迁移进 cli.json（仅在 cli.json 缺失时）。 */
function cliMigrationPending(dir: string): boolean {
  return existsSync(join(dir, 'tui.json')) || existsSync(join(opencodeStateDir(), 'kv.json'));
}

/** 注册 V2 TUI 插件到 cli.json；迁移未完成时返回 null（对应 herdr add_cli_plugin）。 */
async function addCliPlugin(dir: string, spec: string): Promise<string | null> {
  const path = join(dir, 'cli.json');
  checkConfigTarget(path);
  if (!existsSync(path) && cliMigrationPending(dir)) return null;
  await editPluginList(path, 'plugins', spec, true);
  return path;
}

/** 校验 opencode TUI 插件与 V2 注册是否完整（对应 herdr opencode_tui_integration_is_valid）。 */
function opencodeTuiIntegrationIsValid(): boolean {
  const dir = opencodeConfigDir();
  const expected = INTEGRATION_VERSIONS.opencode;
  const tuiVersion = readInstalledVersion(opencodeTuiPluginPath());
  if (tuiVersion === null || tuiVersion < expected) return false;
  if (!tuiPluginIsConfigured(dir, OPENCODE_TUI_PLUGIN_SPEC)) return false;
  if (!existsSync(join(dir, 'cli.json'))) return true;
  if (!pluginIsConfigured(join(dir, 'cli.json'), 'plugins', OPENCODE_V2_TUI_PLUGIN_SPEC)) return false;
  const v2Version = readInstalledVersion(join(opencodeV2Dir(), 'tui.js'));
  return v2Version !== null && v2Version >= expected;
}

function opencodeTarget(): HookTarget {
  const dir = opencodeConfigDir;
  const pluginPath = opencodePluginPath;
  return {
    configDir: dir,
    hookPath: pluginPath,
    isInstalled() {
      // 与 herdr 一致：以 V1 server 插件文件是否存在判定 not-installed；
      // TUI/V2 注册失效时由 hookStatuses 降级为 outdated。
      return scriptInstalled(pluginPath());
    },
    async install(_reportUrl: string) {
      const d = dir();
      checkConfigTarget(join(d, 'tui.jsonc'));
      checkConfigTarget(join(d, 'tui.json'));
      checkConfigTarget(join(d, 'cli.json'));
      let isDir = false;
      try {
        isDir = statSync(d).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        throw new Error(`opencode config directory not found at ${d}. install opencode first`);
      }
      validateOpencodeConfig(d);

      await fs.mkdir(join(d, 'plugins'), { recursive: true });
      // V1 server 插件（由 V1 从 plugins/ 自动加载）。
      await fs.writeFile(pluginPath(), OPENCODE_ASSET, 'utf8');
      // V1 TUI 插件（tui.js 仅作 V2 目录入口，转发到该文件）。
      await fs.writeFile(opencodeTuiPluginPath(), OPENCODE_TUI_SESSION_ASSET, 'utf8');

      await addTuiPlugin(d, OPENCODE_TUI_PLUGIN_SPEC);

      // V2 TUI 目录入口（tui.js 转发到 V1 TUI 文件）。
      await fs.mkdir(opencodeV2Dir(), { recursive: true });
      await fs.writeFile(join(opencodeV2Dir(), 'tui.js'), OPENCODE_TUI_ASSET, 'utf8');

      await addCliPlugin(d, OPENCODE_V2_TUI_PLUGIN_SPEC);
    },
    async uninstall() {
      const d = dir();
      checkConfigTarget(join(d, 'tui.jsonc'));
      checkConfigTarget(join(d, 'tui.json'));
      checkConfigTarget(join(d, 'cli.json'));
      const errors: string[] = [];
      try {
        await editPluginList(join(d, 'cli.json'), 'plugins', OPENCODE_V2_TUI_PLUGIN_SPEC, false);
      } catch (error) {
        errors.push((error as Error).message);
      }
      await fs.rm(opencodeV2Dir(), { recursive: true, force: true }).catch((error) => {
        errors.push(`failed to remove ${opencodeV2Dir()}: ${(error as Error).message}`);
      });
      try {
        await removeTuiPlugin(d, OPENCODE_TUI_PLUGIN_SPEC);
      } catch (error) {
        errors.push((error as Error).message);
      }
      await fs.rm(pluginPath(), { force: true }).catch(() => undefined);
      await fs.rm(opencodeTuiPluginPath(), { force: true }).catch(() => undefined);
      if (errors.length > 0) throw new Error(errors.join('; '));
    },
  };
}

function kiloTarget(): HookTarget {
  return extensionTarget({
    configDir: () => homeJoin('.config', 'kilo'),
    asset: KILO_ASSET,
    fileName: join('plugin', 'herdr-desktop-agent-state.js'),
    requireDir: () => homeJoin('.config', 'kilo'),
    agentLabel: 'kilo',
  });
}

/** 插件名需与 assets/hermes/plugin.yaml 的 name 及插件目录名保持一致。 */
const HERMES_PLUGIN_NAME = 'herdr-desktop-agent-state';

/**
 * 在 hermes config.yaml 里启用/禁用插件（对应 herdr ensure_hermes_plugin_enabled）。
 * 简化处理三种形态：内联列表 `plugins: [...]`、`enabled:` 子列表、扁平列表。
 */
function updateHermesEnabled(content: string, enabled: boolean): string {
  const lines = content.split('\n');
  const pluginsIdx = lines.findIndex((l) => /^plugins\s*:/.test(l));

  if (pluginsIdx < 0) {
    if (!enabled) return content;
    const base = content.replace(/\n+$/, '');
    return `${base}${base ? '\n' : ''}plugins:\n  enabled:\n    - ${HERMES_PLUGIN_NAME}\n`;
  }

  // 内联列表：plugins: [a, b]
  const inline = lines[pluginsIdx].match(/^plugins\s*:\s*\[([^\]]*)\](.*)$/);
  if (inline) {
    const items = inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    const idx = items.indexOf(HERMES_PLUGIN_NAME);
    if (enabled && idx < 0) items.push(HERMES_PLUGIN_NAME);
    if (!enabled && idx >= 0) items.splice(idx, 1);
    // 保留行内注释（对应 herdr yaml_inline_comment）。
    const comment = inline[2].trim();
    const list = items.length ? `[${items.map((s) => `'${s}'`).join(', ')}]` : '[]';
    lines[pluginsIdx] = `plugins: ${list}${comment ? ` ${comment}` : ''}`;
    return lines.join('\n');
  }

  // 块形态：找 enabled 子键或扁平列表项
  const nextTop = lines.findIndex((l, i) => i > pluginsIdx && /^[A-Za-z_][\w-]*\s*:/.test(l));
  const end = nextTop < 0 ? lines.length : nextTop;
  const sub = lines.slice(pluginsIdx + 1, end);
  const enabledIdx = sub.findIndex((l) => /^\s{2}enabled\s*:/.test(l));

  if (enabledIdx >= 0) {
    const enabledLine = pluginsIdx + 1 + enabledIdx;
    // 内联 enabled: [a, b] 形态（对应 herdr 的 yaml_flow_sequence_items）。
    const inlineEnabled = lines[enabledLine].match(/^\s{2}enabled\s*:\s*\[([^\]]*)\](.*)$/);
    if (inlineEnabled) {
      const items = inlineEnabled[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      const idx = items.indexOf(HERMES_PLUGIN_NAME);
      if (enabled && idx < 0) items.push(HERMES_PLUGIN_NAME);
      if (!enabled && idx >= 0) items.splice(idx, 1);
      const comment = inlineEnabled[2].trim();
      const list = items.length ? `[${items.map((s) => `'${s}'`).join(', ')}]` : '[]';
      lines[enabledLine] = `  enabled: ${list}${comment ? ` ${comment}` : ''}`;
      return lines.join('\n');
    }
    // 块形态：enabled:\n    - x
    const listStart = enabledLine + 1;
    let listEnd = listStart;
    while (listEnd < end && /^\s{2,}-\s/.test(lines[listEnd])) listEnd += 1;
    const itemIdx =
      lines.slice(listStart, listEnd).findIndex((l) => l.trim() === `- ${HERMES_PLUGIN_NAME}`) + listStart;
    if (enabled && itemIdx < listStart) lines.splice(listStart, 0, `    - ${HERMES_PLUGIN_NAME}`);
    else if (!enabled && itemIdx >= listStart) lines.splice(itemIdx, 1);
    return lines.join('\n');
  }

  // 扁平列表形态：plugins:\n  - x
  const flatIdx = sub.findIndex((l) => /^\s{2}-\s/.test(l));
  if (flatIdx >= 0) {
    const listStart = pluginsIdx + 1 + flatIdx;
    const itemIdx =
      lines.slice(listStart, end).findIndex((l) => l.trim() === `- ${HERMES_PLUGIN_NAME}`) + listStart;
    if (enabled && itemIdx < listStart) lines.splice(listStart, 0, `  - ${HERMES_PLUGIN_NAME}`);
    else if (!enabled && itemIdx >= listStart) lines.splice(itemIdx, 1);
    return lines.join('\n');
  }

  // 有 plugins 键但没有 enabled/列表：追加 enabled 子键
  if (enabled) {
    lines.splice(pluginsIdx + 1, 0, '  enabled:', `    - ${HERMES_PLUGIN_NAME}`);
    return lines.join('\n');
  }

  return content;
}

/** hermes 目录：HERMES_HOME → Windows HOME(≠USERPROFILE)/.hermes → LOCALAPPDATA/hermes → ~/.hermes（对应 herdr hermes_dir）。 */
function hermesDir(): string {
  const env = process.env.HERMES_HOME?.trim();
  if (env) return expandTilde(env);
  if (isWindows) {
    const home = process.env.HOME?.trim();
    const profile = process.env.USERPROFILE?.trim();
    if (home && home !== profile) return join(home, '.hermes');
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) return join(localAppData, 'hermes');
  }
  return homeJoin('.hermes');
}

function hermesTarget(): HookTarget {
  const dir = hermesDir;
  const pluginDir = () => join(dir(), 'plugins', 'herdr-desktop-agent-state');
  const configPath = () => join(dir(), 'config.yaml');
  return {
    configDir: dir,
    hookPath: () => join(pluginDir(), '__init__.py'),
    isInstalled() {
      return scriptInstalled(this.hookPath());
    },
    async install(_reportUrl: string) {
      await fs.mkdir(pluginDir(), { recursive: true });
      await fs.writeFile(join(pluginDir(), 'plugin.yaml'), HERMES_PLUGIN_YAML, 'utf8');
      await fs.writeFile(join(pluginDir(), '__init__.py'), HERMES_PLUGIN_INIT, 'utf8');

      // 在 config.yaml 启用插件（对应 herdr ensure_hermes_plugin_enabled）。
      const content = await readText(configPath());
      const updated = updateHermesEnabled(content, true);
      if (updated !== content) await writeConfigFile(configPath(), updated);
    },
    async uninstall() {
      const content = await readText(configPath());
      const updated = updateHermesEnabled(content, false);
      if (updated !== content) await writeConfigFile(configPath(), updated);
      await fs.rm(pluginDir(), { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// DeepSeek Harness（dsh web）—— 非 hook 集成（Cordis 插件）
// ---------------------------------------------------------------------------

/**
 * 安装位置用 Harness 全局 home（`$DSH_HOME`，默认 `~/.dsh`），而非某个 profile：
 * - 插件是自包含、无依赖的单文件，且未设置 `HERDR_DESKTOP_REPORT_URL` 时是 no-op，
 *   挂到 home 层不会影响任何非 Herdr 启动的 dsh 进程；
 * - home 层 `cordis.patch.yml` 不属于 profile 自动初始化写入的文件，避免 Herdr 先
 *   安装、随后 `dsh web` 首次启动自动初始化 profile 时把条目冲掉。
 */
function dshWebTarget(): HookTarget {
  const homeDir = () => {
    const home = process.env.DSH_HOME?.trim();
    return home ? home : join(homedir(), '.dsh');
  };
  const pluginPath = () => join(homeDir(), 'plugins', DSH_STATUS_PLUGIN_NAME);
  const patchPath = () => join(homeDir(), 'cordis.patch.yml');

  return {
    configDir: homeDir,
    hookPath: pluginPath,
    isInstalled() {
      const path = pluginPath();
      if (!path || !existsSync(path)) return false;
      try {
        return readFileSync(path, 'utf8').includes(`HERDR_INTEGRATION_ID=${INTEGRATION_ID}`);
      } catch {
        return false;
      }
    },
    async install(_reportUrl: string) {
      await fs.mkdir(join(homeDir(), 'plugins'), { recursive: true });
      await fs.writeFile(pluginPath(), DSH_STATUS_PLUGIN, 'utf8');
      await upsertDshPatch(patchPath());
    },
    async uninstall() {
      await removeDshPatchBlock(patchPath());
      await fs.rm(pluginPath(), { force: true }).catch(() => undefined);
    },
  };
}

const DSH_PATCH_BEGIN = '# >>> herdr dsh integration';
const DSH_PATCH_END = '# <<< herdr dsh integration';

/** 生成需要追加进 home 层 cordis.patch.yml 的插件注册块。 */
function dshPatchBlock(): string {
  return [
    '',
    DSH_PATCH_BEGIN,
    '- insert:',
    '    - id: herdr-desktop-agent-state',
    `      name: ./plugins/${DSH_STATUS_PLUGIN_NAME}`,
    DSH_PATCH_END,
    '',
  ].join('\n');
}

/** 幂等地把插件注册块追加进 home 层 cordis.patch.yml（已存在则不动）。 */
async function upsertDshPatch(patchPath: string): Promise<void> {
  const content = await readText(patchPath);
  if (content.includes(DSH_PATCH_BEGIN)) return;
  const trimmed = content.replace(/\r?\n$/, '');
  const next =
    trimmed.length === 0
      ? dshPatchBlock().trim() + '\n'
      : `${trimmed}\n${dshPatchBlock()}`;
  await writeConfigFile(patchPath, next);
}

/** 移除 home 层 cordis.patch.yml 中的插件注册块（不存在则不动）。 */
async function removeDshPatchBlock(patchPath: string): Promise<void> {
  const content = await readText(patchPath);
  const begin = content.indexOf(DSH_PATCH_BEGIN);
  if (begin < 0) return;
  const end = content.indexOf(DSH_PATCH_END);
  const after = end >= 0 ? end + DSH_PATCH_END.length : content.length;
  const cleaned = (content.slice(0, begin) + content.slice(after))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
  if (cleaned.length === 0) {
    await fs.rm(patchPath, { force: true }).catch(() => undefined);
    return;
  }
  await writeConfigFile(patchPath, `${cleaned}\n`);
}
