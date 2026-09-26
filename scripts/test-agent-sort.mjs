/*
 * 验证侧栏 agent 列表按显示名字母序排列。
 *
 * 直接跑 src/stores/agentSort.ts 里的真实实现（而非复制一份比较器），
 * 否则测试通过不代表应用里的排序是对的。
 *
 * 重点覆盖几个容易写错的点：
 * - 大小写混排（不能用码点直接比，否则大写全排在小写前）
 * - 数字段（agent2 应在 agent10 前）
 * - 同名回退 paneId，保证稳定
 * - 排序键必须是用户看到的显示名（label 优先于 name）
 */
import { agentDisplayName, compareAgents, compareAgentNames } from '../.tmp-agentsort.mjs';
import { AGENT_PRESETS } from '../.tmp-agentpresets.mjs';

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(`PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}\n      期望 ${e}\n      实际 ${a}`);
  }
}

const mk = (label, name, paneId) => ({ label, name, paneId });

// 1. 大小写混排：必须按字母序，而非码点序
check(
  '大小写混排按字母序',
  [mk('Zed', null, 'p1'), mk('apple', null, 'p2'), mk('Banana', null, 'p3')]
    .sort(compareAgents)
    .map(agentDisplayName),
  ['apple', 'Banana', 'Zed'],
);

// 2. 数字段：agent2 在 agent10 之前
check(
  '数字段自然序',
  [mk('agent10', null, 'p1'), mk('agent2', null, 'p2'), mk('agent1', null, 'p3')]
    .sort(compareAgents)
    .map(agentDisplayName),
  ['agent1', 'agent2', 'agent10'],
);

// 3. 排序键用显示名：label 优先于 name
check(
  'label 优先于 name 作为排序键',
  [mk(null, 'zeta', 'p1'), mk('alpha', 'zeta', 'p2')].sort(compareAgents).map(agentDisplayName),
  ['alpha', 'zeta'],
);

// 4. 同名回退 paneId，保证稳定
check(
  '同名时按 paneId 稳定',
  [mk('same', null, 'pb'), mk('same', null, 'pa')].sort(compareAgents).map((a) => a.paneId),
  ['pa', 'pb'],
);

// 5. 稳定性：打乱输入，输出必须一致
const pool = [
  mk('delta', null, 'p1'),
  mk('Alpha', null, 'p2'),
  mk('charlie', null, 'p3'),
  mk('bravo', null, 'p4'),
  mk('alpha', null, 'p5'),
];
const expected = ['Alpha', 'alpha', 'bravo', 'charlie', 'delta'];
const shuffled = [
  [...pool].reverse(),
  [pool[2], pool[0], pool[4], pool[1], pool[3]],
  [pool[4], pool[3], pool[2], pool[1], pool[0]],
];
const allSame = shuffled.every(
  (arr) =>
    JSON.stringify(arr.sort(compareAgents).map(agentDisplayName)) === JSON.stringify(expected),
);
check('不同输入顺序得到同一结果', allSame, true);

// 6. 缺 label 且缺 name 的兜底
check('无 label/name 时兜底为 agent', agentDisplayName(mk(null, null, 'p1')), 'agent');

/*
 * 7. 分组集成：模拟 useProjectGroups 的流水线（filter → map → sort），
 *    确认排序发生在分组之后、且不会跨项目串味。
 */
const state = {
  projects: [{ projectId: 'projA' }, { projectId: 'projB' }],
  agents: [
    { projectId: 'projA', label: 'zulu', name: null, paneId: 'a1', status: 'idle' },
    { projectId: 'projB', label: 'yankee', name: null, paneId: 'b1', status: 'idle' },
    { projectId: 'projA', label: 'alpha', name: null, paneId: 'a2', status: 'blocked' },
    { projectId: 'projA', label: 'mike', name: null, paneId: 'a3', status: 'working' },
  ],
  panes: [{ paneId: 'a1', running: false }],
};
const groups = state.projects.map((project) => {
  const agents = state.agents
    .filter((a) => a.projectId === project.projectId)
    .map((a) => ({ ...a, running: state.panes.find((p) => p.paneId === a.paneId)?.running ?? true }))
    .sort(compareAgents);
  return { projectId: project.projectId, names: agents.map(agentDisplayName), agents };
});
check('分组内按字母序', groups[0].names, ['alpha', 'mike', 'zulu']);
check('不跨项目串味', groups[1].names, ['yankee']);
check('计数基于排序后的列表', groups[0].agents.filter((a) => a.status === 'blocked').length, 1);
check('running 兜底仍生效', groups[0].agents.map((a) => a.running), [true, true, false]);

/*
 * 8. AGENT_PRESETS 必须已按字母序导出（三个消费方都直接 map 它）。
 *    这里不重排，而是断言它本身有序——否则测试会掩盖实现里的遗漏。
 */
const presetLabels = AGENT_PRESETS.map((p) => p.label);
const isSorted = presetLabels.every(
  (label, i) => i === 0 || compareAgentNames(presetLabels[i - 1], label) <= 0,
);
check('AGENT_PRESETS 已按字母序', isSorted, true);
check('AGENT_PRESETS 无丢失', AGENT_PRESETS.length, 26);
check('AGENT_PRESETS 含全部关键项', ['Claude Code', 'Codex', 'OpenCode', 'Terminal'].every((l) =>
  presetLabels.includes(l),
), true);
console.log(`     预设顺序: ${presetLabels.join(' / ')}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
