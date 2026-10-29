/**
 * integrationsStore 胶水层验证脚本（请求号 / busy 生命周期 / 复核权威状态）。
 *
 * 覆盖的核心场景是「有集成更新时侧栏显示待更新数量，直到所有更新完成才消失」
 * 在 store 层的行为：
 * - 整表拉取的单调请求号：先发后到的旧快照被丢弃，不会把徽标数字跳回旧值；
 * - 安装/卸载不写回单条返回值，只以复核后的权威状态为准：opencode / grok
 *   还要检查 TUI 脚本与配置，单条返回值说「装好了」时权威状态可能仍是
 *   outdated，写回会让徽标先减一、复核后又跳回来；
 * - busy 按 agentId 记录：并发安装两个智能体时，先完成者不会把另一个的
 *   「进行中」清掉；
 * - 一键安装只碰本机可用的智能体，并以权威状态收敛。
 *
 * 做法与其它 test:* 一致：先用 esbuild 把被测模块打成 ESM，再 import 真实实现
 * （而非复制逻辑），避免测试与实现漂移。两个 store 必须打进同一个 bundle
 * （入口 scripts/test-integrations-store.entry.mjs），否则会得到两份 zustand
 * 实例，测试改的那份不是被测代码读的那份。
 *
 * 用法: npm run test:integrations-store
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundlePath = join(process.cwd(), '.tmp/integrations-store.mjs');
if (!existsSync(bundlePath)) {
  console.error('missing .tmp/integrations-store.mjs — run: npm run test:integrations-store');
  process.exit(2);
}

/** Main 侧 stub 的可控状态。 */
let authority = {}; // getHookStatuses 的权威返回
let statusQueue = []; // 指定某几次拉取的延迟与返回值（构造「先发后到」）
let statusCalls = 0;
let installedIds = [];
let uninstalledIds = [];
let installResult = {};
let uninstallResult = {};
let installDelays = {}; // agentId → 毫秒，用来固定并发安装的完成顺序
let uninstallDelay = 0;
let installError = null;
let availability = {}; // command → 是否在本机

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * 预加载 API 是在调用时才读 window.herdrDesktop 的（src/ipc/client.ts 的 api()），
 * 所以只要在 import 之前把 stub 挂上即可，不需要为测试改被测代码。
 */
globalThis.window = {
  herdrDesktop: {
    getHookStatuses: async () => {
      statusCalls += 1;
      const next = statusQueue.shift();
      if (next) {
        await sleep(next.delay);
        return structuredClone(next.value);
      }
      return structuredClone(authority);
    },
    installHook: async (agentId) => {
      installedIds.push(agentId);
      await sleep(installDelays[agentId] ?? 0);
      if (installError) throw installError;
      return installResult[agentId] ?? 'installed';
    },
    uninstallHook: async (agentId) => {
      uninstalledIds.push(agentId);
      await sleep(uninstallDelay);
      return uninstallResult[agentId] ?? 'not-installed';
    },
    getAgentAvailability: async () => structuredClone(availability),
  },
};

const { useIntegrationsStore, useAgentsStore, useNotificationStore, AGENT_PRESETS } = await import(
  pathToFileURL(bundlePath).href
);

const results = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, pass });
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}` +
      (pass ? '' : `\n        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`),
  );
}

/** 每个场景开始前把两个 store 与 stub 复位（模块内的 refreshSeq 单调递增，无需复位）。 */
function reset() {
  useIntegrationsStore.setState({ hookStatuses: {}, busy: [], busyAll: false });
  useAgentsStore.setState({ availability: {}, probed: false });
  authority = {};
  statusQueue = [];
  statusCalls = 0;
  installedIds = [];
  uninstalledIds = [];
  installResult = {};
  uninstallResult = {};
  installDelays = {};
  uninstallDelay = 0;
  installError = null;
  availability = {};
}

/** 记录一段区间内 hookStatuses 与 busy / busyAll 的变化序列。 */
function record() {
  const statusSeq = [];
  const busySeq = [];
  const busyAllSeq = [];
  const stop = useIntegrationsStore.subscribe((s) => {
    statusSeq.push({ ...s.hookStatuses });
    busySeq.push(s.busy.join(','));
    busyAllSeq.push(s.busyAll);
  });
  return { statusSeq, busySeq, busyAllSeq, stop };
}

/** agentId → 本机探测用的命令名（可用性表按命令名索引）。 */
const commandOf = (agentId) => AGENT_PRESETS.find((p) => p.id === agentId).command;

/* 1. 整表拉取的单调请求号：先发后到的旧快照必须被丢弃。 */
reset();
statusQueue = [
  { delay: 20, value: { claude: 'outdated' } }, // 先发：慢，返回旧值
  { delay: 0, value: { claude: 'installed' } }, // 后发：快，返回新值
];
await Promise.all([
  useIntegrationsStore.getState().refresh(),
  useIntegrationsStore.getState().refresh(),
]);
check(
  '先发后到的旧快照被丢弃（请求号）',
  useIntegrationsStore.getState().hookStatuses,
  { claude: 'installed' },
);

/* 2. 安装不写回单条返回值：权威仍是 outdated 时徽标不得先减后跳回。 */
reset();
authority = { claude: 'outdated' }; // 实际没更新成功（如 TUI 脚本/配置无效）
installResult = { claude: 'installed' }; // 单条返回值却是 installed
useIntegrationsStore.setState({ hookStatuses: { claude: 'outdated' } });
const installRec = record();
await useIntegrationsStore.getState().install('claude');
installRec.stop();
check(
  '安装期间不出现「先减后跳回」（无乐观写回）',
  installRec.statusSeq.map((m) => m.claude).includes('installed'),
  false,
);
check('安装后以权威状态收敛', useIntegrationsStore.getState().hookStatuses, {
  claude: 'outdated',
});

/* 3. 卸载同样以权威状态为准，且确实复核了一次。 */
reset();
authority = { claude: 'outdated' }; // 半失败的卸载：权威仍是 outdated
uninstallResult = { claude: 'installed' }; // 单条返回值却是 installed
useIntegrationsStore.setState({ hookStatuses: { claude: 'outdated' } });
const statusCallsBefore = statusCalls;
await useIntegrationsStore.getState().uninstall('claude');
check('卸载后复核权威状态', statusCalls > statusCallsBefore, true);
check('卸载后以权威状态覆盖单条返回值', useIntegrationsStore.getState().hookStatuses, {
  claude: 'outdated',
});

/* 4. busy 按 agentId 记录：并发安装时先完成者不清掉另一个。 */
reset();
authority = { claude: 'installed', codex: 'installed' };
installDelays = { claude: 5, codex: 25 };
const busyRec = record();
await Promise.all([
  useIntegrationsStore.getState().install('claude'),
  useIntegrationsStore.getState().install('codex'),
]);
busyRec.stop();
check(
  '并发安装时两个 id 同时在 busy 里',
  busyRec.busySeq.includes('claude,codex'),
  true,
);
check('先完成者只清掉自己（另一个仍在进行中）', busyRec.busySeq.includes('codex'), true);
check('全部完成后 busy 清空', useIntegrationsStore.getState().busy, []);

/* 5. 一键安装：只碰本机可用的智能体，并以权威状态收敛。 */
reset();
availability = {
  [commandOf('claude')]: true,
  [commandOf('codex')]: false,
  [commandOf('maki')]: true,
};
authority = { claude: 'not-installed', codex: 'not-installed', maki: 'not-installed' };
// installAll 读的是 store 里的状态表（不是 stub 的 authority），先把它铺好。
useIntegrationsStore.setState({ hookStatuses: authority });
await useAgentsStore.getState().refresh();
const allRec = record();
await useIntegrationsStore.getState().installAll();
allRec.stop();
check('一键安装只碰本机可用的智能体', installedIds, ['claude', 'maki']);
check('一键安装以权威状态收敛', useIntegrationsStore.getState().hookStatuses, authority);
check('一键安装期间置 busyAll、结束后复位', allRec.busyAllSeq.includes(true), true);
check('一键安装结束后 busyAll 复位', useIntegrationsStore.getState().busyAll, false);

/* 6. 安装失败：清 busy 并给出错误提示（剥掉 Electron IPC 包装的前缀）。 */
reset();
authority = { claude: 'outdated' };
useIntegrationsStore.setState({ hookStatuses: { claude: 'outdated' } });
const pushes = [];
const originalPush = useNotificationStore.getState().push;
useNotificationStore.setState({
  push: (notification) => {
    pushes.push(notification);
    originalPush(notification);
  },
});
installError = new Error(
  "Error invoking remote method 'herdr-desktop:install-hook': Error: EACCES: permission denied",
);
await useIntegrationsStore.getState().install('claude');
useNotificationStore.setState({ push: originalPush });
check('安装失败后 busy 清空', useIntegrationsStore.getState().busy, []);
check(
  '安装失败给出错误提示（已剥掉 IPC 包装前缀）',
  pushes.map((n) => [n.titleKey, n.titleVars?.agent, n.detailVars?.error]),
  [['settings.integrationInstallFailed', 'claude', 'EACCES: permission denied']],
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error(`failed: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}
