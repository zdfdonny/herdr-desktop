/*
 * 验证侧栏 agent 列表按创建时间升序排列（早创建的在前）。
 *
 * 直接跑 src/stores/agentSort.ts 里的真实实现（而非复制一份比较器），
 * 否则测试通过不代表应用里的排序是对的。
 *
 * 重点覆盖几个容易写错的点：
 * - 按 createdAt 升序，而不是按显示名字母序
 * - createdAt 相同时回退 paneId，保证稳定
 * - 排序不跨项目串味
 * - 显示名（label 优先于 name）仍是行渲染与兜底的唯一来源
 * - AGENT_PRESETS（agent 选择器）仍按字母序导出
 */
import {
  agentDisplayName,
  compareAgentsByCreatedAt,
  compareAgentNames,
} from '../.tmp-agentsort.mjs';
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

const mk = (label, name, paneId, createdAt) => ({ label, name, paneId, createdAt });

// 1. 按创建时间升序：顺序必须由 createdAt 决定，而非显示名字母序
check(
  '按创建时间升序',
  [
    mk('alpha', null, 'p1', 300),
    mk('mike', null, 'p2', 200),
    mk('zulu', null, 'p3', 100),
  ]
    .sort(compareAgentsByCreatedAt)
    .map(agentDisplayName),
  ['zulu', 'mike', 'alpha'],
);

// 2. createdAt 相同时回退 paneId，保证稳定
check(
  '创建时间相同时按 paneId 稳定',
  [mk('b', null, 'pb', 100), mk('a', null, 'pa', 100)]
    .sort(compareAgentsByCreatedAt)
    .map((a) => a.paneId),
  ['pa', 'pb'],
);

// 3. 稳定性：打乱输入，输出必须一致（按 createdAt）
const pool = [
  mk('one', null, 'p1', 5),
  mk('two', null, 'p2', 1),
  mk('three', null, 'p3', 4),
  mk('four', null, 'p4', 2),
  mk('five', null, 'p5', 3),
];
const expected = ['two', 'four', 'five', 'three', 'one'];
const shuffled = [
  [...pool].reverse(),
  [pool[2], pool[0], pool[4], pool[1], pool[3]],
  [pool[4], pool[3], pool[2], pool[1], pool[0]],
];
const allSame = shuffled.every(
  (arr) =>
    JSON.stringify(arr.sort(compareAgentsByCreatedAt).map(agentDisplayName)) ===
    JSON.stringify(expected),
);
check('不同输入顺序得到同一结果', allSame, true);

// 4. 缺 label 且缺 name 的兜底
check('无 label/name 时兜底为 agent', agentDisplayName(mk(null, null, 'p1', 0)), 'agent');

// 5. 显示名仍是 label 优先于 name
check(
  'label 优先于 name 作为显示名',
  [mk(null, 'zeta', 'p1', 1), mk('alpha', 'zeta', 'p2', 2)].map(agentDisplayName),
  ['zeta', 'alpha'],
);

/*
 * 6. 分组集成：模拟 useProjectGroups 的流水线（filter → map → sort），
 *    确认排序发生在分组之后、按创建时间升序、且不会跨项目串味。
 */
const state = {
  projects: [{ projectId: 'projA' }, { projectId: 'projB' }],
  agents: [
    { projectId: 'projA', label: 'zulu', name: null, paneId: 'a1', createdAt: 100, status: 'idle' },
    { projectId: 'projB', label: 'yankee', name: null, paneId: 'b1', createdAt: 1, status: 'idle' },
    { projectId: 'projA', label: 'alpha', name: null, paneId: 'a2', createdAt: 300, status: 'blocked' },
    { projectId: 'projA', label: 'mike', name: null, paneId: 'a3', createdAt: 200, status: 'working' },
  ],
  panes: [{ paneId: 'a1', running: false }],
};
const groups = state.projects.map((project) => {
  const agents = state.agents
    .filter((a) => a.projectId === project.projectId)
    .map((a) => ({ ...a, running: state.panes.find((p) => p.paneId === a.paneId)?.running ?? true }))
    .sort(compareAgentsByCreatedAt);
  return { projectId: project.projectId, names: agents.map(agentDisplayName), agents };
});
check('分组内按创建时间升序', groups[0].names, ['zulu', 'mike', 'alpha']);
check('不跨项目串味', groups[1].names, ['yankee']);
check('计数基于排序后的列表', groups[0].agents.filter((a) => a.status === 'blocked').length, 1);
check('running 兜底仍生效', groups[0].agents.map((a) => a.running), [false, true, true]);

/*
 * 7. AGENT_PRESETS 必须已按字母序导出（agent 选择器直接 map 它）。
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
