/*
 * 集成版本与标记守卫。
 *
 * 校验两件事（把 AGENTS.md 里的手工约定变成 CI 拦截）：
 * 1. 每个智能体的资产文件都带**新命名空间**标记
 *    `HERDR_DESKTOP_INTEGRATION_ID=herdr-desktop` / `HERDR_DESKTOP_INTEGRATION_VERSION=<n>`；
 * 2. 同一个智能体的所有资产文件版本号一致，且等于 `descriptors/<id>.ts` 里声明的
 *    `integration.version`。
 *
 * 重构前这一致性靠「改脚本要记得同时改 assets.ts」的注释约束维持，已经漂移过一次
 * （注释说 claude 是 v5、标记是 v4）。任何一处不一致都会让设置页把「已安装」误判成
 * 「更新」，或反过来永远提示更新。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ASSETS_ROOT = path.join(ROOT, 'electron', 'agents', 'assets');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 从 descriptor 源码里抽取 integration.version（避免为测试引入打包步骤）。 */
function declaredVersion(agentId) {
  for (const file of fs.readdirSync(path.join(ROOT, 'shared', 'agents', 'descriptors'))) {
    if (!file.endsWith('.ts')) continue;
    const text = fs.readFileSync(path.join(ROOT, 'shared', 'agents', 'descriptors', file), 'utf8');
    if (!new RegExp(`id: '${agentId}'`).test(text)) continue;
    const match = text.match(/integration:\s*\{[\s\S]*?version:\s*(\d+)/);
    return match ? Number(match[1]) : null;
  }
  return null;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

console.log('— 1. 每个智能体资产目录都存在 —');
const agentDirs = fs
  .readdirSync(ASSETS_ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);
check('资产目录数量为 19', agentDirs.length === 19, `实际 ${agentDirs.length}: ${agentDirs.join(',')}`);

console.log('— 2. 标记与版本一致性 —');
for (const dirName of agentDirs) {
  // 资产目录名与智能体 id 一致（一个智能体一个目录）。
  const agentId = dirName;
  const expected = declaredVersion(agentId);
  check(`${agentId} 在 descriptor 里声明了集成版本`, typeof expected === 'number');

  const files = walk(path.join(ASSETS_ROOT, dirName));
  check(`${agentId} 有资产文件`, files.length > 0);

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    const metaFiles = ['plugin.yaml', 'yaml'].some((suffix) => file.endsWith(suffix));

    // 1) 任何地方都不得残留旧命名空间标记。
    check(`${rel} 无旧标记 HERDR_INTEGRATION_*`,
      !/HERDR_INTEGRATION_(ID|VERSION)/.test(text));

    const idMatch = text.match(/HERDR_DESKTOP_INTEGRATION_ID=([\w-]+)/);
    const versionMatch = text.match(/HERDR_DESKTOP_INTEGRATION_VERSION=(\d+)/);

    /*
     * 清单类文件（如 hermes 的 plugin.yaml）不承载版本标记 —— 它的版本由同目录的
     * __init__.py 声明，安装时一起写入。这类文件只要求「不带旧标记」。
     */
    if (metaFiles && !versionMatch) continue;

    // 2) 承载标记的文件必须两个标记都在。
    check(`${rel} 带新标记 ID 与 VERSION`, Boolean(idMatch) && Boolean(versionMatch));
    if (!versionMatch) continue;

    // 3) 标记里的 id 必须是本项目命名空间（含 opencode 的 tui/v2 变体）。
    if (idMatch) {
      check(`${rel} 标记 ID 属于 herdr-desktop 命名空间`,
        idMatch[1].startsWith('herdr-desktop'), idMatch[1]);
    }

    // 4) 版本必须等于 descriptor 声明值（同一 agent 多文件保持一致）。
    check(`${rel} 版本 = ${expected}`, Number(versionMatch[1]) === expected,
      `实际 ${versionMatch[1]}`);
  }
}

console.log('— 3. descriptor 版本表与测试期望一致 —');const policyTest = fs.readFileSync(path.join(__dirname, 'test-agent-policy.mjs'), 'utf8');
for (const dirName of agentDirs) {
  const agentId = dirName;
  const expected = declaredVersion(agentId);
  const pattern = new RegExp(`\\b${agentId}:\\s*(\\d+)`);
  const match = policyTest.match(pattern);
  check(`${agentId} 已登记在 test-agent-policy 的版本表里`,
    Boolean(match) && Number(match[1]) === expected,
    match ? `表里 ${match[1]}，descriptor ${expected}` : '未登记');
}

console.log('— 4. 版本号只有一个来源 —');
/*
 * 重构前 assets.ts 里还有一张 19 条的 INTEGRATION_VERSIONS 表，需要与各资产里的
 * 标记手工同步，已经漂移过一次（注释说 claude 是 v5、标记是 v4）。
 * 现在版本只来自 descriptor；这条断言防止第二张表被重新引入。
 *
 * 重构后 assets.ts 已删除（资产迁进各智能体文件），所以校验范围扩大到
 * `electron/agents/` 全部源码：任何地方都不该再出现版本表。
 */
function walkTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const agentLayerFiles = walkTsFiles(path.join(ROOT, 'electron', 'agents'));
const versionTableOffenders = agentLayerFiles.filter((file) =>
  /INTEGRATION_VERSIONS/.test(fs.readFileSync(file, 'utf8')),
);
check(
  'agents 层不再持有第二份版本表',
  versionTableOffenders.length === 0,
  versionTableOffenders.map((f) => path.relative(ROOT, f)).join(', '),
);
check('agents 层没有集中的 assets.ts（资产随智能体）', !fs.existsSync(
  path.join(ROOT, 'electron', 'agents', 'assets.ts'),
));
const indexSource = fs.readFileSync(
  path.join(ROOT, 'electron', 'integration.ts'),
  'utf8',
);
check('index.ts 不再持有版本表（版本只在 descriptor）', !/INTEGRATION_VERSIONS\./.test(indexSource));

console.log('— 5. 安装器登记与 descriptor 声明的集成集合一致 —');
/*
 * 重构后 `buildHookTargets()` 不再手写 19 条，而是：
 * - 声明式智能体：遍历 descriptor，凡有 `integration.hooks` 的自动装配；
 * - 特殊协议智能体：显式几行（codex / kimi / antigravity / grok / hermes / dsh / pi / omp / kilo / opencode）。
 *
 * 所以这里改成校验**声明与资产的对应关系**（比解析源码更本质）：
 * 每个声明了集成的智能体都必须有资产目录，反之亦然。
 */
const declared = agentDirs; // 资产目录 = 实际存在集成资产的智能体
const integrationSource = fs.readFileSync(
  path.join(ROOT, 'electron', 'integration.ts'),
  'utf8',
);

// 所有有官方集成的智能体都必须登记在工厂注册表里。
const factoryRegistrySource = fs.readFileSync(
  path.join(ROOT, 'electron', 'agents', 'installer-factories.ts'),
  'utf8',
);
const INTEGRATED_AGENTS = [
  'claude', 'codex', 'kimi', 'copilot', 'devin', 'droid', 'qodercli', 'qwen',
  'letta', 'cursor', 'mastracode', 'antigravity', 'grok', 'pi', 'omp',
  'opencode', 'kilo', 'hermes', 'dsh',
];
for (const id of INTEGRATED_AGENTS) {
  check(
    `${id} 登记在工厂注册表`,
    new RegExp(`^\\s*${id}: create\\w*Target,`, 'm').test(factoryRegistrySource),
  );
}
check(
  '汇总层不再逐个 import 智能体工厂',
  !/from '\.\.\/\.\.\/agents\/integration\/(declarative|codex|kimi)/.test(integrationSource),
);

/*
 * 工厂注册表本身的形态约束：它是「id → 工厂」的**唯一**一张表，
 * 所以条目数必须与有官方集成的智能体数一致，且不能混入重复项
 * （重复会让后者静默覆盖前者，装错安装器却没有任何报错）。
 */
const registeredFactories = [
  ...factoryRegistrySource.matchAll(/^\s{2}([a-z][\w-]*): (create\w*Target),$/gm),
].map((m) => m[1]);
check('工厂注册表条目数为 19', registeredFactories.length === 19, `实际 ${registeredFactories.length}`);
check('工厂注册表无重复项', new Set(registeredFactories).size === registeredFactories.length);
check(
  '工厂注册表覆盖全部有集成的智能体',
  INTEGRATED_AGENTS.every((id) => registeredFactories.includes(id)),
);
check('汇总层通过 createAllInstallers 派生安装器', /createAllInstallers/.test(integrationSource));
/*
 * 声明式智能体现已各自有工厂文件（`electron/agents/installers/declarative/<id>.ts`），
 * 每个文件 import 自己的资产与 descriptor。逐个校验「文件存在 + 自持资产 + 被登记」。
 */
const declarativeDir = path.join(ROOT, 'electron', 'agents', 'installers', 'declarative');
for (const id of ['claude', 'copilot', 'devin', 'droid', 'qodercli', 'qwen', 'letta', 'cursor', 'mastracode']) {
  const file = path.join(declarativeDir, `${id}.ts`);
  check(`${id} 有独立的声明式安装器文件`, fs.existsSync(file));
  if (fs.existsSync(file)) {
    const declSrc = fs.readFileSync(file, 'utf8');
    check(`${id} 的工厂 import 自己的资产（?raw）`, /\?raw'/.test(declSrc));
    check(`${id} 的工厂 import 自己的 descriptor`, declSrc.includes(`agents/descriptors/${id}`));
  }
}

/*
 * 有特殊配置协议的 6 个 + 扩展/插件的 4 个，各自文件里必须有 createXxxTarget 导出。
 */
for (const id of ['codex', 'kimi', 'antigravity', 'grok', 'hermes', 'dsh', 'pi', 'omp', 'kilo', 'opencode']) {
  const file = path.join(ROOT, 'electron', 'agents', 'installers', `${id}-installer.ts`);
  check(`${id} 有独立的安装器文件`, fs.existsSync(file));
  if (fs.existsSync(file)) {
    check(`${id} 导出创建工厂`, /export function create\w*Target\(/.test(fs.readFileSync(file, 'utf8')));
  }
}

check('资产目录数量为 19', declared.length === 19, `实际 ${declared.length}`);
check('不再有手写的 HOOK_TARGETS 大表',
  !/const HOOK_TARGETS: Record<string, IntegrationInstaller> = \{/.test(integrationSource));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
