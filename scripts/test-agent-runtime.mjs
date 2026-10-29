/*
 * 智能体运行时注册表测试 —— `electron/agents/` 这一层的契约。
 *
 * 校验「智能体 id → 主进程实现（集成安装器）」这层查表能力本身的语义：
 * 登记 / 查找 / 未知 id / 与 descriptor 的组合。
 *
 * 注意：这里**不**依赖真实的 19 个安装器（那些模块用 Vite 的 `?raw` 导入资产，
 * esbuild 打不进来）。「每个声明了集成的智能体都登记了安装器」由
 * `test:integration-version` 做静态断言。
 */

import {
  AGENT_IDS,
  agentById,
  agentRuntime,
  allAgents,
  installerFor,
  installedRuntimeIds,
  registerInstaller,
} from '../.tmp/agent-runtime.mjs';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 造一个最小的安装器桩（只关心注册表语义，不落盘）。 */
function stubInstaller(version) {
  return {
    configDir: () => '/tmp/x',
    artifactPath: () => '/tmp/x/a.sh',
    isInstalled: () => false,
    version: () => version,
    install: async () => {},
    uninstall: async () => {},
  };
}

console.log('— 1. 注册表基本语义 —');
check('未登记时取不到安装器', installerFor('claude') === null);
check('未知 id 返回 null', installerFor('nope') === null);
check('空值返回 null', installerFor(null) === null && installerFor(undefined) === null);

registerInstaller('claude', stubInstaller(5));
check('登记后能取到', installerFor('claude') !== null);
check('取到的版本正确', installerFor('claude').version() === 5);
check('重复登记覆盖旧值', (() => {
  registerInstaller('claude', stubInstaller(6));
  return installerFor('claude').version() === 6;
})());
check('登记表里出现该 id', installedRuntimeIds().includes('claude'));

console.log('— 2. 与 descriptor 组合 —');
const runtime = agentRuntime('claude');
check('agentRuntime 返回 descriptor', runtime?.descriptor.id === 'claude');
check('agentRuntime 带出安装器', runtime?.installer?.version() === 6);
check('agentRuntime 对未知 id 返回 null', agentRuntime('nope') === null);

// 未登记安装器但 descriptor 存在的智能体：runtime 仍可用，installer 为 null。
const noInstaller = allAgents().find((d) => installerFor(d.id) === null);
check('有智能体尚未登记安装器（说明 installer 可为 null）', noInstaller !== undefined);
if (noInstaller) {
  const r = agentRuntime(noInstaller.id);
  check(`${noInstaller.id}：runtime 可用但 installer 为 null`,
    r !== null && r.installer === null);
}

console.log('— 3. 注册表完整性 —');
check('每个 id 都能解析到 descriptor', AGENT_IDS.every((id) => agentById(id) !== null));
check('descriptor 数量与 AGENT_IDS 一致', allAgents().length === AGENT_IDS.length);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
