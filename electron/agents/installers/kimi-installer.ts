/**
 * Kimi Code CLI 的集成安装器 —— `JsonHooksInstaller` 的第五个子类。
 *
 * 三处差异：
 * 1. **安装前跑版本闸门**：hooks 需要 0.14.0+，太旧直接抛错阻断，
 *    避免装上一个 CLI 根本不认识的配置；
 * 2. 配置是 **TOML**（`config.toml` 的 `[[hooks]]` 块），用块标记包裹，
 *    卸载时按标记整块移除 —— 不能像 JSON 那样按 path 定位；
 * 3. 事件带 matcher，用来把 `AskUserQuestion` 与其它工具分流成 blocked / working。
 *
 * 因此完全不走通用 JSON hooks 流程（`managesHooksConfig() === false`）。
 */

import { JsonHooksInstaller } from './json-hooks-installer';
import type { JsonHooksInstallerDeps, JsonHooksLayout, JoinPath } from './json-hooks-installer';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isWindows } from '../../platform';
import type { IntegrationInstaller } from '../installer';
import { HOOK_SCRIPT_NAME, checkConfigTarget, declaredVersion, ensureHook, ensureHooksObject, envOrHome, hookCommand, hooksObjectIfPresent, jsonHooksIo, readText, removeHook, scriptInstalled, writeConfigFile } from './kit';
import sh from '../assets/kimi/herdr-desktop-agent-state.sh?raw';
import ps1 from '../assets/kimi/herdr-desktop-agent-state.ps1?raw';

/** kimi 需要的额外 IO：版本探测 + TOML 块读写。 */
export interface KimiInstallerIo {
  /** 版本闸门；太旧时抛错。 */
  enforceMinVersion(): Promise<void>;
  /** 预检 config.toml 可写。 */
  checkTomlTarget(dir: string): void;
  readText(path: string): Promise<string>;
  writeConfigFile(path: string, content: string): Promise<void>;
  /** 在已有 TOML 上重建 `[[hooks]]` 块。 */
  configWithHook(content: string, artifactPath: string): string;
  /** 按块标记移除。 */
  removeBlock(content: string): string;
}

export class KimiInstaller extends JsonHooksInstaller {
  constructor(
    layout: JsonHooksLayout,
    deps: JsonHooksInstallerDeps,
    join: JoinPath,
    private readonly kimi: KimiInstallerIo,
  ) {
    super(layout, deps, join);
  }

  /** 配置是 TOML 块，不走 JSON hooks 流程。 */
  protected override managesHooksConfig(): boolean {
    return false;
  }

  /**
   * 版本闸门放在最前面：太旧的 CLI 装了也用不上，不如直接告诉用户升级。
   * 抛错即中止安装，不会留下任何产物。
   */
  protected override async checkPreconditions(_dir: string): Promise<void> {
    await this.kimi.enforceMinVersion();
  }

  /** 写 `[[hooks]]` 块（失败时不留半安装：TOML 预检在前）。 */
  protected override async registerExtra(
    dir: string,
    artifactPath: string,
    _configPath: string,
  ): Promise<void> {
    const configPath = this.join(dir, 'config.toml');
    this.kimi.checkTomlTarget(dir);
    const content = await this.kimi.readText(configPath);
    await this.kimi.writeConfigFile(
      configPath,
      this.kimi.configWithHook(content, artifactPath),
    );
  }

  /** 按块标记整块移除。 */
  protected override async unregisterExtra(
    dir: string,
    _artifactPath: string | null,
    _configPath: string,
  ): Promise<void> {
    const configPath = this.join(dir, 'config.toml');
    const content = await this.kimi.readText(configPath);
    await this.kimi.writeConfigFile(configPath, this.kimi.removeBlock(content));
  }
}

/**
 * 创建 kimi 的集成安装器。
 *
 * 放在智能体自己的文件里：TOML [[hooks]] 块协议、版本闸门（0.14.0+）、
 * 会话专用脚本资产都只属于 kimi。
 */
export function createKimiTarget(): IntegrationInstaller {
  const configDir = (): string | null => envOrHome('KIMI_CODE_HOME', ['.kimi-code']);
  const artifactPath = (): string | null => {
    const dir = configDir();
    return dir ? join(dir, 'hooks', HOOK_SCRIPT_NAME) : null;
  };

  return new KimiInstaller(
    {
      configFile: 'config.toml',
      shape: 'nested',
      event: 'SessionStart',
      // TOML 块由 registerExtra 整体重建；这里保留声明以便与其它智能体同构。
      events: KIMI_HOOK_EVENTS.map(([event, matcher, action]) => [
        event,
        action,
        { matcher: matcher ?? undefined },
      ]),
      artifactSubdir: 'hooks',
    },
    {
      configDir,
      artifactPath,
      version: () => declaredVersion('kimi'),
      command: (path, action) => hookCommand(path, action),
      artifactIsInstalled: (path) => scriptInstalled(path),
      artifactContent: () => (isWindows ? ps1 : sh),
      io: jsonHooksIo(),
      ops: { ensureHooksObject, hooksObjectIfPresent, ensureHook, removeHook },
    },
    join,
    {
      enforceMinVersion: () => checkKimiVersion(),
      checkTomlTarget: (dir) => checkConfigTarget(join(dir, 'config.toml')),
      readText: (path) => readText(path),
      writeConfigFile: (path, content) => writeConfigFile(path, content),
      configWithHook: (content, artifactPath2) =>
        kimiConfigWithHook(content, artifactPath2, KIMI_HOOK_EVENTS),
      removeBlock: (content) => removeKimiBlock(content),
    },
  );
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

export function kimiConfigWithHook(
  content: string,
  scriptPath: string,
  events: Array<[event: string, matcher: string | null, action: string]>,
): string {
  // 对应 herdr build_kimi_config_with_hooks：总是先移除旧块再重建，确保重装同步最新事件。
  let result = removeKimiBlock(content).replace(/\r?\n$/, '');
  if (result) result += '\n\n';
  const rows = [KIMI_BLOCK_BEGIN];
  for (const [event, matcher, action] of events) {
    rows.push('[[hooks]]', `event = "${event}"`);
    if (matcher) rows.push(`matcher = ${tomlString(matcher)}`);
    rows.push(`command = ${tomlString(hookCommand(scriptPath, action))}`, 'timeout = 10', '');
  }
  rows.push(KIMI_BLOCK_END);
  return `${result}${rows.join('\n')}\n`;
}

export function removeKimiBlock(content: string): string {
  const begin = content.indexOf(KIMI_BLOCK_BEGIN);
  const end = content.indexOf(KIMI_BLOCK_END);
  if (begin < 0) return content;
  const after = end >= 0 ? end + KIMI_BLOCK_END.length : content.length;
  return (content.slice(0, begin) + content.slice(after)).replace(/\n{3,}/g, '\n\n');
}

export function tomlString(value: string): string {
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

/**
 * antigravity-cli（agy）—— 独立块 + 目录预检，骨架复用 `AntigravityInstaller`。
 */

/** kimi 的事件集（matcher 区分 AskUserQuestion）。 */
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
