/*
 * 全量测试聚合。
 *
 * 为什么不用 `&&` 串起来：
 * - 24 个脚本串成一行后，`package.json` 里那一行没法看；
 * - `&&` 在第一个失败处就停，看不到「其它的是不是也坏了」——排查时更想知道全貌；
 * - 拿不到统一的通过/失败统计。
 *
 * 本 runner 逐个执行、收集结果、最后打汇总表。**任何一个失败则退出码为 1**，
 * 所以它可以直接当 `npm test` 用（CI 只跑这一个入口）。
 *
 * 顺序有意为之：
 * 1. `typecheck` —— 类型错误会让后续 esbuild 报难懂的错，先拦住；
 * 2. 静态守卫（编码 / 边界 / 打包命名）—— 秒级，早失败早省时间；
 * 3. 主进程核心（状态机 / 策略 / 安装器 / 服务）—— 断言最多、风险最高；
 * 4. 渲染层纯函数 —— 与主进程无耦合，放最后。
 */
import { spawn } from 'node:child_process';

/** 待执行的脚本，按上述顺序分组。 */
const STEPS = [
  // 1. 类型
  { name: 'typecheck', group: 'types' },

  // 2. 静态守卫（毫秒级）
  { name: 'check:encoding', group: 'guards' },
  { name: 'check:agent-boundaries', group: 'guards' },
  { name: 'check:artifacts', group: 'guards' },

  // 3. 主进程核心
  { name: 'test:terminal-state', group: 'main' },
  { name: 'test:agent-policy', group: 'main' },
  { name: 'test:integration-version', group: 'main' },
  { name: 'test:arbitration', group: 'main' },
  { name: 'test:suppression-ledger', group: 'main' },
  { name: 'test:state-arbiter', group: 'main' },
  { name: 'test:detect-engine', group: 'main' },
  { name: 'test:pane-service', group: 'main' },
  { name: 'test:dsh-binding', group: 'main' },
  { name: 'test:notification-scheduler', group: 'main' },
  { name: 'test:agent-runtime', group: 'main' },
  { name: 'test:installer-snapshots', group: 'main' },
  { name: 'test:json-hooks-installer', group: 'main' },
  { name: 'test:unix', group: 'main' },
  { name: 'test:conpty-dll', group: 'main' },

  // 4. 渲染层
  { name: 'test:layout', group: 'renderer' },
  { name: 'test:sort', group: 'renderer' },
  { name: 'test:pane-nav', group: 'renderer' },
  { name: 'test:picker', group: 'renderer' },
  { name: 'test:shortcuts', group: 'renderer' },
  { name: 'test:integrations', group: 'renderer' },
  { name: 'test:integrations-store', group: 'renderer' },
];

const GROUP_TITLES = {
  types: '类型检查',
  guards: '静态守卫',
  main: '主进程核心',
  renderer: '渲染层',
};

/** 跑一个 npm 脚本，返回 { ok, passed, failed, ms }。 */
function runStep(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    // npm 在 Windows 上要经 cmd 解析，用 shell 模式最省事
    const child = spawn('npm', ['run', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });

    child.on('close', (code) => {
      const passedMatch = output.match(/(\d+)\s+passed/);
      const failedMatch = output.match(/(\d+)\s+failed/);
      resolve({
        ok: code === 0,
        passed: passedMatch ? Number(passedMatch[1]) : null,
        failed: failedMatch ? Number(failedMatch[1]) : null,
        ms: Date.now() - started,
        // 失败时保留最后几行，便于直接定位
        tail: code === 0 ? '' : output.trim().split('\n').slice(-12).join('\n'),
      });
    });
  });
}

const results = [];
let currentGroup = null;

for (const step of STEPS) {
  if (step.group !== currentGroup) {
    currentGroup = step.group;
    console.log(`\n=== ${GROUP_TITLES[currentGroup]} ===`);
  }
  process.stdout.write(`  ${step.name} … `);
  const result = await runStep(step.name);
  results.push({ name: step.name, ...result });

  const count = result.passed !== null ? `${result.passed} 断言` : '—';
  console.log(`${result.ok ? '✓' : '✗'} ${count} (${result.ms}ms)`);
  if (!result.ok && result.tail) {
    console.log(result.tail.replace(/^/gm, '      '));
  }
}

// ---- 汇总 ----
const failedSteps = results.filter((r) => !r.ok);
const totalPassed = results.reduce((sum, r) => sum + (r.passed ?? 0), 0);
const totalMs = results.reduce((sum, r) => sum + r.ms, 0);

console.log('\n' + '─'.repeat(60));
console.log(`步骤 ${results.length - failedSteps.length}/${results.length} 通过`);
console.log(`断言 ${totalPassed} 条，用时 ${(totalMs / 1000).toFixed(1)}s`);

if (failedSteps.length > 0) {
  console.error(`\n失败 ${failedSteps.length} 个：`);
  for (const step of failedSteps) console.error(`  ✗ ${step.name}`);
  process.exit(1);
}

console.log('全部通过 ✓');
