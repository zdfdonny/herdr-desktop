/*
 * 智能体策略矩阵测试 —— 重构前后的**行为契约**。
 *
 * 每个智能体的关键策略位逐条断言，值按重构前的代码人工核对填写：
 * - hookAuthority        ← 原 fullLifecycleHookAuthority / sessionIdentityOnlyIntegration
 * - screenOwnsCompletion ← 原 screenCompletionIgnored（取反）
 * - ignoreStartupWorking ← 原 screenStartupIgnored
 * - acceptsHeartbeat     ← 原 isStaleHeartbeat 的隐含前提（claude 的 PostToolUse 是唯一心跳来源）
 * - sessionRebinding     ← 原 terminal-state.ts 里的 4 处内联 if
 * - routeBySessionId     ← 原 router 的 'herdr-desktop:dsh' 分支
 * - readiness            ← 原 codexPromptReady 的 3 处判定
 *
 * 任何一行变红都说明语义漂移。
 */

import {
  AGENT_IDS,
  agentById,
  allAgents,
  detectAgentName,
  fullLifecycleHookAuthority,
  integrableAgents,
  parseAgentLabel,
  resolveWebAgent,
  resumableAgents,
  screenCompletionIgnored,
  screenStartupIgnored,
  sessionIdentityOnlyIntegration,
  webAgents,
} from '../.tmp/agent-policy.mjs';

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

const LINUX = { platform: 'linux', env: {}, home: '/home/x' };

console.log('— 1. 注册表完整性 —');
check('注册表条数与 AGENT_IDS 一致', allAgents().length === AGENT_IDS.length,
  `${allAgents().length} vs ${AGENT_IDS.length}`);
check('allAgents() 顺序与 AGENT_IDS 一致（按识别优先级排序）',
  allAgents().every((d, i) => d.id === AGENT_IDS[i]));
/*
 * 识别优先级必须**显式声明且唯一**。
 *
 * 这两条取代了原先「靠 DESCRIPTORS 数组位置表达优先级」的隐式约定：
 * 现在新增智能体给一个数字即可，插到数组哪里都不影响别人；
 * 而唯一性校验能防止两个 agent 抢同一个位置（那时结果取决于 id 字典序，
 * 极易成为难查的识别错误）。
 */
check('每个 descriptor 都声明了 detectionPriority',
  allAgents().every((d) => typeof d.detectionPriority === 'number'));
{
  const priorities = allAgents().map((d) => d.detectionPriority);
  const dupes = priorities.filter((p, i) => priorities.indexOf(p) !== i);
  check('detectionPriority 互不重复', dupes.length === 0, `重复: ${dupes.join(',')}`);
}
check('allAgents() 按 detectionPriority 升序',
  allAgents().every((d, i, arr) => i === 0 || arr[i - 1].detectionPriority <= d.detectionPriority));
check('每个 id 都能按 id 查回自己', AGENT_IDS.every((id) => agentById(id)?.id === id));
check('未知 id 返回 null', agentById('nope') === null && agentById(null) === null);
check('每个 descriptor 都有 label 与非空 command',
  allAgents().every((d) => d.label.length > 0 && d.command(LINUX).length > 0));

console.log('— 2. 别名归一 —');
const ALIAS_CASES = [
  ['claude-code', 'claude'], ['cursor-agent', 'cursor'], ['devin-cli', 'devin'],
  ['agy', 'antigravity'], ['antigravity-cli', 'antigravity'], ['.cline', 'cline'],
  ['mastra-code', 'mastracode'], ['opencode2', 'opencode'], ['github-copilot', 'copilot'],
  ['ghcs', 'copilot'], ['kimi-code', 'kimi'], ['kiro-cli', 'kiro'], ['amp-local', 'amp'],
  ['grok-build', 'grok'], ['hermes-agent', 'hermes'], ['kilo-code', 'kilo'],
  ['qoder', 'qodercli'], ['qwen-code', 'qwen'], ['letta-code', 'letta'],
  ['muse-cli', 'muse'],
];
for (const [alias, expected] of ALIAS_CASES) {
  check(`别名 ${alias} → ${expected}`, parseAgentLabel(alias) === expected,
    `实际 ${parseAgentLabel(alias)}`);
}
check('canonical 名自洽', AGENT_IDS.every((id) => parseAgentLabel(id) === id));
check('可执行后缀被剥离', parseAgentLabel('claude.cmd') === 'claude');
check('路径被取 basename', parseAgentLabel('/usr/bin/claude') === 'claude');
check('未知标签返回 null', parseAgentLabel('nope-cli') === null);

console.log('— 3. 状态仲裁策略（逐 agent） —');
const POLICY_CASES = [
  // id,          hookAuthority,      screenOwns, startupIgnored, heartbeat, rebinding,             routeBySessionId, promptMarker
  ['pi',             'full-lifecycle', true,  false, false, 'default',              false, false],
  ['claude',         'state',          false, false, true,  'default',              false, false],
  ['codex',          'state',          true,  false, false, 'explicit-replace',     false, true],
  ['gemini',         'state',          true,  false, false, 'default',              false, false],
  ['cursor',         'state',          true,  false, false, 'default',              false, false],
  ['devin',          'state',          true,  false, false, 'default',              false, false],
  ['antigravity',    'state',          false, true,  false, 'default',              false, false],
  ['cline',          'state',          true,  false, false, 'default',              false, false],
  ['omp',            'full-lifecycle', true,  false, false, 'default',              false, false],
  ['mastracode',     'full-lifecycle', true,  false, false, 'overwrite-persisted',  false, false],
  ['opencode',       'full-lifecycle', true,  false, false, 'unsequenced-select',   false, false],
  ['copilot',        'state',          true,  false, false, 'default',              false, false],
  ['kimi',           'full-lifecycle', true,  false, false, 'default',              false, false],
  ['kiro',           'state',          true,  false, false, 'default',              false, false],
  ['droid',          'state',          true,  false, false, 'default',              false, false],
  ['amp',            'state',          true,  false, false, 'default',              false, false],
  ['grok',           'state',          true,  false, false, 'default',              false, false],
  ['hermes',         'none',           true,  false, false, 'default',              false, false],
  ['kilo',           'full-lifecycle', true,  false, false, 'default',              false, false],
  ['qodercli',       'state',          true,  false, false, 'default',              false, false],
  ['qwen',           'none',           true,  false, false, 'default',              false, false],
  ['letta',          'none',           true,  false, false, 'default',              false, false],
  ['maki',           'state',          true,  false, false, 'default',              false, false],
  ['muse',           'state',          true,  false, false, 'default',              false, false],
  ['dsh',            'state',          true,  false, false, 'default',              true,  false],
];

check('策略矩阵覆盖全部智能体', POLICY_CASES.length === AGENT_IDS.length,
  `${POLICY_CASES.length} vs ${AGENT_IDS.length}`);
for (const row of POLICY_CASES) {
  const [id, authority, screenOwns, startupIgnored, heartbeat, rebinding, routeBySession, promptMarker] = row;
  const d = agentById(id);
  if (!d) {
    check(`${id} 存在`, false);
    continue;
  }
  const p = d.policy;
  const ok =
    p.hookAuthority === authority &&
    p.screenOwnsCompletion === screenOwns &&
    p.ignoreStartupWorking === startupIgnored &&
    p.acceptsHeartbeat === heartbeat &&
    p.sessionRebinding.mode === rebinding &&
    p.routeBySessionId === routeBySession &&
    p.readiness.requiresPromptMarker === promptMarker;
  check(`${id} 策略`, ok, ok ? '' : JSON.stringify({
    authority: p.hookAuthority,
    screenOwns: p.screenOwnsCompletion,
    startupIgnored: p.ignoreStartupWorking,
    heartbeat: p.acceptsHeartbeat,
    rebinding: p.sessionRebinding.mode,
    routeBySession: p.routeBySessionId,
    promptMarker: p.readiness.requiresPromptMarker,
  }));
}

check('只有 grok 不允许前台接管他人会话',
  allAgents().filter((d) => !d.policy.sessionRebinding.allowForegroundTakeover).map((d) => d.id)
    .join(',') === 'grok');
check('只有 opencode 拒绝别家会话的状态上报（防串台）',
  allAgents().filter((d) => d.policy.sessionRebinding.rejectsCrossSessionReports === true)
    .map((d) => d.id).join(',') === 'opencode');
check('会话重绑语义的分布符合预期',
  ['explicit-replace:codex', 'unsequenced-select:opencode', 'overwrite-persisted:mastracode']
    .every((pair) => {
      const [mode, id] = pair.split(':');
      return agentById(id)?.policy.sessionRebinding.mode === mode;
    }));
check('屏幕不判完成的恰好是 claude + antigravity',
  allAgents().filter((d) => !d.policy.screenOwnsCompletion).map((d) => d.id).join(',') ===
    'claude,antigravity');
check('「完成交给 hook」需要集成已安装的恰好是 claude + antigravity',
  allAgents().filter((d) => d.policy.completionRequiresIntegration).map((d) => d.id).join(',') ===
    'claude,antigravity');

/*
 * 会话替换白名单（对应重构前 `SESSION_REPLACEMENT_ALLOWED` 的 32 条）。
 *
 * 这张表决定「一条会话上报是否允许换掉 pane 当前锚定的会话」。漏声明 = 该智能体
 * 的会话切换静默失效（/clear、--resume、branch 之后 pane 仍钉在旧会话上，
 * 重启续回错的对话），而这在界面上只有一个很弱的信号，必须逐条锁死。
 */
const REPLACEMENT_SOURCES = {
  claude: ['', 'clear', 'compact', 'fork', 'resume'],
  codex: ['clear', 'compact', 'resume', 'startup'],
  antigravity: [''],
  hermes: ['new', 'resume', 'startup'],
  qwen: ['branch', 'clear', 'compact', 'resume', 'startup'],
  mastracode: ['startup'],
  opencode: ['select'],
  pi: ['fork', 'new', 'resume'],
  grok: ['new'],
  omp: ['fork', 'new', 'resume', 'startup'],
};
for (const [id, sources] of Object.entries(REPLACEMENT_SOURCES)) {
  const declared = [...(agentById(id)?.resume?.replacementSources ?? [])].sort();
  check(`${id} 的会话替换白名单与重构前一致`,
    declared.join(',') === [...sources].sort().join(','),
    `期望 ${[...sources].sort().join(',')}，实际 ${declared.join(',')}`);
}
check('没有多余的智能体声明会话替换白名单',
  allAgents()
    .filter((d) => d.resume?.replacementSources !== undefined)
    .map((d) => d.id)
    .sort()
    .join(',') === Object.keys(REPLACEMENT_SOURCES).sort().join(','));

console.log('— 4. 旧谓词函数与新策略等价 —');
for (const id of AGENT_IDS) {
  const d = agentById(id);
  const source = `herdr-desktop:${id}`;
  check(`fullLifecycleHookAuthority(${id})`,
    fullLifecycleHookAuthority(source, id) === (d.policy.hookAuthority === 'full-lifecycle'));
  check(`sessionIdentityOnlyIntegration(${id})`,
    sessionIdentityOnlyIntegration(source, id) === (d.policy.hookAuthority === 'none'));
  check(`screenCompletionIgnored(${id})`,
    screenCompletionIgnored(id) === !d.policy.screenOwnsCompletion);
  check(`screenStartupIgnored(${id})`,
    screenStartupIgnored(id) === d.policy.ignoreStartupWorking);
  check(`来源不匹配则不认（${id}）`,
    fullLifecycleHookAuthority('herdr-desktop:lore', id) === false &&
    sessionIdentityOnlyIntegration('herdr-desktop:lore', id) === false);
  // 旧命名空间一律不认（不做兼容层，见 AGENTS.md 命名空间规则）。
  check(`旧前缀 herdr:${id} 不被认作官方来源`,
    fullLifecycleHookAuthority(`herdr:${id}`, id) === false &&
    sessionIdentityOnlyIntegration(`herdr:${id}`, id) === false);
}

console.log('— 5. 能力面的口径一致 —');
check('有集成的智能体都有版本号',
  integrableAgents().every((d) => typeof d.integration.version === 'number'));
check('有集成的智能体都有 configDir 与 artifactPath',
  integrableAgents().every((d) =>
    typeof d.integration.configDir === 'function' &&
    typeof d.integration.artifactPath === 'function'));
check('有恢复声明的智能体都能生成 tail',
  resumableAgents().every((d) => typeof d.resume.tail === 'function'));
check('dsh 是唯一的 web 型',
  allAgents().filter((d) => d.hosting === 'web').map((d) => d.id).join(',') === 'dsh');

/*
 * web 是**宿主形态**，不是某个具体智能体。
 * 这组断言防止有人再把「web 型」和 dsh 划等号（例如在 createWebAgent 里写死 agentId）。
 */
check('web 型智能体有合法的启动命令与 launchArgs',
  allAgents().filter((d) => d.hosting === 'web').every((d) =>
    d.command(LINUX).length > 0 && Array.isArray(d.launchArgs)));
check('dsh 的 launchArgs 是 web 子命令（记录完整启动命令用）',
  agentById('dsh')?.launchArgs?.join(' ') === 'web');
check('pty 型智能体都不声明 web 子命令',
  allAgents().filter((d) => d.hosting !== 'web')
    .every((d) => !(d.launchArgs ?? []).includes('web')));
// 关键：显式指定非 web 型智能体时必须被拒绝，而不是悄悄当成 dsh 处理。
check('resolveWebAgent 拒绝 pty 型智能体', resolveWebAgent('claude') === null);
check('resolveWebAgent 接受 web 型智能体', resolveWebAgent('dsh')?.id === 'dsh');
check('resolveWebAgent 缺省时取唯一的 web 型', resolveWebAgent()?.id === 'dsh');
check('resolveWebAgent 拒绝未知 id', resolveWebAgent('nope') === null);
check('webAgents() 只含 hosting === web',
  webAgents().every((d) => d.hosting === 'web'));
check('有集成声明的智能体都能解析出产物路径',
  integrableAgents().every((d) => (d.integration.artifactPath(LINUX) ?? '').length > 0));
check('集成产物路径都落在 configDir 之下',
  integrableAgents().every((d) => {
    const dir = d.integration.configDir(LINUX);
    const artifact = d.integration.artifactPath(LINUX);
    if (!dir || !artifact) return true;
    return artifact === dir || artifact.startsWith(`${dir}/`);
  }));

console.log('— 6. 识别顺序（first-match 语义） —');
check('claude 输出里能识别出 claude', detectAgentName('some claude code output') === 'claude');
check('agy 识别为 antigravity', detectAgentName('running agy now') === 'antigravity');
check('pi 不被 "api" 误命中', detectAgentName('api server ready') === null);

console.log('— 7. 集成版本（与资产标记的一致性由 test:integration-version 守卫） —');
const EXPECTED_VERSIONS = {
  claude: 5, codex: 4, kimi: 4, copilot: 4, devin: 4, droid: 4, qodercli: 4, qwen: 4,
  letta: 4, cursor: 4, mastracode: 4, antigravity: 6, grok: 4, pi: 4, omp: 5,
  opencode: 5, kilo: 4, hermes: 3, dsh: 6,
};
for (const [id, version] of Object.entries(EXPECTED_VERSIONS)) {
  check(`${id} 集成版本 = ${version}`, agentById(id)?.integration?.version === version,
    `实际 ${agentById(id)?.integration?.version}`);
}
check('有集成的恰好 19 个', integrableAgents().length === Object.keys(EXPECTED_VERSIONS).length);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
