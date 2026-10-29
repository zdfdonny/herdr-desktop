/*
 * 智能体边界 lint —— 防止「agent 特例」重新散落到业务代码里。
 *
 * 重构的目标形态：一个智能体的全部知识只存在于
 *   - shared/agents/descriptors/<agent>.ts   （静态事实）
 *   - electron/agents/<agent>/              （需要 fs/进程的实现，逐步迁入）
 * 其它任何地方都不该出现 `agent === 'claude'` 这类分支。
 *
 * 没有这条约束，重构三个月后会退化成原样 —— 这正是本次重构要解决的问题本身。
 *
 * 用法：node scripts/check-agent-boundaries.mjs
 * 退出码 1 表示发现越界引用（CI 拦截）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/*
 * agent id 清单直接读源码字面量，而不是 import agent-id.ts：
 * 后者是 TypeScript，在纯 node 下需要额外转译步骤（本项目 test:* 都靠 esbuild 打包）。
 * 这里只解析 AGENT_IDS 数组，保持本脚本零构建依赖。
 */
const agentIdSource = fs.readFileSync(
  path.join(ROOT, 'shared', 'agents', 'agent-id.ts'),
  'utf8',
);
const idsBlock = /export const AGENT_IDS = \[([\s\S]*?)\] as const;/.exec(agentIdSource);
if (!idsBlock) {
  console.error('无法从 shared/agents/agent-id.ts 解析 AGENT_IDS');
  process.exit(1);
}
const AGENT_IDS = [...idsBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

/**
 * 允许出现 agent id 字面量的地方。
 *
 * - 注册表与 descriptor：智能体知识的唯一归属；
 * - 检测 manifest 数据：纯声明式规则，属于 descriptor 的一部分；
 * - 测试：按设计就是要逐智能体断言；
 * - 资产脚本：脚本自身必须声明 source/agent；
 * - 本脚本与文档。
 */
const ALLOWED_PREFIXES = [
  path.join('shared', 'agents') + path.sep,
  path.join('shared', 'detect') + path.sep,
  path.join('electron', 'agents') + path.sep,
  path.join('electron', 'runtime', 'integration', 'assets') + path.sep,
];

const ALLOWED_FILES = new Set([
  // 测试
  path.join('scripts', 'test-agent-policy.mjs'),
  path.join('scripts', 'test-integration-version.mjs'),
  path.join('scripts', 'test-terminal-state.mjs'),
  path.join('scripts', 'test-agent-sort.mjs'),
  path.join('scripts', 'test-integrations-store.mjs'),
  path.join('scripts', 'test-integrations-store.entry.mjs'),
  path.join('scripts', 'test-agent-policy.entry.mjs'),
  path.join('scripts', 'test-agent-runtime.mjs'),
  path.join('scripts', 'test-agent-runtime.entry.mjs'),
  path.join('scripts', 'test-integration-updates.mjs'),
  path.join('scripts', 'check-agent-boundaries.mjs'),
]);

/** 扫描目录（跳过 node_modules / 构建产物 / 临时 bundle）。 */
function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (name === 'node_modules' || name === 'dist' || name === 'dist-electron' || name === 'release') {
      continue;
    }
    if (name === '.tmp') continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      collect(full, out);
    } else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
      out.push(path.relative(ROOT, full));
    }
  }
  return out;
}

/**
 * 只在「比较/赋值语境」里检测 agent 字面量。
 *
 * 单纯出现在注释、字符串键（如 `'deepseek'`）或 descriptor 声明里不算越界 ——
 * 这里刻意用保守模式，避免误报导致大家关掉这条检查。
 */
const COMPARISON = new RegExp(
  `(===|!==|==|!=)\\s*['"\`](${AGENT_IDS.join('|')})['"\`]` +
    `|['"\`](${AGENT_IDS.join('|')})['"\`]\\s*(===|!==|==|!=)`,
);
/** `case 'claude':` 形态的分支。 */
const CASE_LABEL = new RegExp(`\\bcase\\s+['"\`](${AGENT_IDS.join('|')})['"\`]`);

/** 逐行扫描（忽略行注释里的内容，避免把示例注释当成违规）。 */
function violationsIn(source) {
  const found = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // 去掉 `//` 之后的注释部分（简单处理：不在字符串里的 // 之后视为注释）。
    const code = line.replace(/(^|\s)\/\/.*$/, '$1');
    if (COMPARISON.test(code) || CASE_LABEL.test(code)) {
      found.push({ line: i + 1, text: line.trim() });
    }
  }
  return found;
}

const roots = ['shared', 'electron', 'src', 'scripts']
  .map((d) => path.join(ROOT, d))
  .filter((d) => fs.existsSync(d));

const files = roots.flatMap((d) => collect(d));
const problems = [];

for (const rel of files) {
  const normalized = rel.split(path.sep).join(path.sep);
  if (ALLOWED_FILES.has(normalized)) continue;
  if (ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) continue;

  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const hit of violationsIn(source)) {
    problems.push({ file: rel, ...hit });
  }
}

console.log(`扫描 ${files.length} 个文件，检查 agent 字面量分支…\n`);

if (problems.length === 0) {
  console.log('✅ 没有越界的 agent 特例分支');
  console.log('   智能体知识集中在 shared/agents/（descriptor）与 electron/agents/（实现）。');
  process.exit(0);
}

console.error(`❌ 发现 ${problems.length} 处越界的 agent 特例分支：\n`);
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}`);
  console.error(`    ${p.text}`);
}
console.error(
  '\n处理方式：把分支改成读 descriptor 的策略/能力（如 policy.screenOwnsCompletion、' +
    'sessionRebinding.mode），而不是在此处再判断 agent id。',
);
process.exit(1);
