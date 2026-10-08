/**
 * layoutStore.reconcile 的分屏恢复逻辑验证脚本。
 *
 * 覆盖的核心场景是「应用重启后分屏布局的保留与恢复」：
 * - 停止态 pane 不能被剪掉（否则重启后整个分屏树被清空，分屏丢失）；
 * - 停止态 pane 不该被铺成新视图；
 * - 停止→运行翻转后 pane 应留在原位（不重复开视图）；
 * - 真正从会话里消失的 pane 才剪掉，并折叠只剩单子节点的 split。
 *
 * 做法与 test-unix-platform.mjs 一致：先用 esbuild 把 layoutStore.ts
 * 打成 ESM，再 import 真实实现（而非复制逻辑），避免测试与实现漂移。
 * layoutStore 在 Node 下可运行：localStorage 未定义时 loadLayout/saveLayout
 * 都走 try/catch 兜底为「空布局」，zustand 的 create 也无需 React。
 *
 * 用法: npm run test:layout
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundlePath = join(process.cwd(), '.tmp-layout.mjs');
if (!existsSync(bundlePath)) {
  console.error('missing .tmp-layout.mjs — run: npm run test:layout');
  process.exit(2);
}
const { useLayoutStore, viewProjectId } = await import(pathToFileURL(bundlePath).href);

const results = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, pass });
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}` +
      (pass ? '' : `\n        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`),
  );
}

/** 构造最小可用的 PaneState。 */
function pane(id, projectId, running) {
  return { paneId: id, projectId, running, label: id, cwd: null, focused: false, kind: 'pty' };
}

/** 收集树里所有 pane 叶子的 paneId（按遍历顺序）。 */
function collectPanes(node) {
  if (!node) return [];
  if (node.type === 'pane') return [node.paneId];
  if (node.type === 'split') {
    return [...collectPanes(node.children[0]), ...collectPanes(node.children[1])];
  }
  return [];
}

/** 收集所有视图里的 paneId（展平成一组）。 */
function allPaneIds(views) {
  return views.map((v) => collectPanes(v.tree)).flat();
}

const store = useLayoutStore;

// ---- 场景一：重启后停止态 pane 保留分屏 ----
store.getState().reset();

// 造一个「A 在左、空位在右」的分屏
store.getState().reconcile([pane('A', 'p1', true)], null);
store.getState().splitPane('A', 'right', 'p1');
// 新 pane B（运行中）填补空位 → split(A, B)
store.getState().reconcile([pane('A', 'p1', true), pane('B', 'p1', true)], null);

let views = store.getState().views;
check('分屏建立：两个 pane 在同一视图', allPaneIds(views), ['A', 'B']);
check('分屏建立：只有一个视图', views.length, 1);

// 模拟重启：A、B 都变为停止态
store.getState().reconcile([pane('A', 'p1', false), pane('B', 'p1', false)], null);
views = store.getState().views;
check('重启后分屏保留：仍是两个 pane', allPaneIds(views), ['A', 'B']);
check('重启后不重复开视图：仍是一个视图', views.length, 1);

// ---- 场景二：点击恢复其中一个（B 停止→运行）不重复开视图 ----
store.getState().reconcile([pane('A', 'p1', false), pane('B', 'p1', true)], null);
views = store.getState().views;
check('恢复 B 后仍留在原位：两个 pane', allPaneIds(views), ['A', 'B']);
check('恢复 B 后不重复开视图：仍是一个视图', views.length, 1);

// ---- 场景三：真正删除的 pane 才被剪掉并折叠 ----
store.getState().reconcile([pane('B', 'p1', true)], null);
views = store.getState().views;
check('删除 A 后折叠为单 pane', allPaneIds(views), ['B']);
check('删除 A 后仍是一个视图', views.length, 1);

// ---- 场景四：停止态 pane 不被铺成新视图（布局丢失的兜底不吞停止态） ----
store.getState().reset();
store.getState().reconcile([pane('A', 'p1', false), pane('B', 'p1', false)], null);
views = store.getState().views;
check('全停止态且无布局：不自动开视图', views.length, 0);

// ---- 场景五：closeView 关闭标签后，reconcile 不把摘除的 pane 复活成新标签 ----
store.getState().reset();
// 造一个分屏视图
store.getState().reconcile([pane('A', 'p1', true)], null);
store.getState().splitPane('A', 'right', 'p1');
store.getState().reconcile([pane('A', 'p1', true), pane('B', 'p1', true)], null);
const viewId = store.getState().views[0].id;
// 关闭这个标签（视图），但 pane 仍在会话里运行
store.getState().closeView(viewId);
views = store.getState().views;
check('closeView 后视图被移除', views.length, 0);
// 同样的快照再次到来（签名未变）：不应把 A、B 铺成新视图
store.getState().reconcile([pane('A', 'p1', true), pane('B', 'p1', true)], null);
views = store.getState().views;
check('closeView 后 reconcile 不复活摘除的 pane', views.length, 0);
// 用户从侧栏点选被摘除的 pane → 解除隐藏，重新开视图
store.getState().reconcile([pane('A', 'p1', true), pane('B', 'p1', true)], 'A');
views = store.getState().views;
check('侧栏点选被摘除的 pane 后重新开视图', views.length, 1);
check('侧栏点选后新视图只含被点选的 pane', allPaneIds(views), ['A']);

// ---- 场景六：关闭分屏里的一个智能体 → 停留在当前 tab；关闭最后一个 → 关掉当前 tab ----
store.getState().reset();
// 造分屏 split(A, B)
store.getState().reconcile([pane('A', 'p1', true)], null);
store.getState().splitPane('A', 'right', 'p1');
store.getState().reconcile([pane('A', 'p1', true), pane('B', 'p1', true)], null);
const splitViewId = store.getState().views[0].id;
// 关闭分屏里的 B：折叠为单 pane，视图（tab）保留
store.getState().reconcile([pane('A', 'p1', true)], 'A');
views = store.getState().views;
check('关闭分屏里的一个智能体：视图保留', views.length, 1);
check('关闭分屏里的一个智能体：视图 id 不变', views[0].id, splitViewId);
check('关闭分屏里的一个智能体：折叠为剩余 pane', allPaneIds(views), ['A']);
// 关闭最后一个 A：视图（tab）关闭
store.getState().reconcile([], null);
views = store.getState().views;
check('关闭最后一个智能体：视图关闭', views.length, 0);

// ---- 场景七：布局丢失时，聚焦项目下的停止态 pane 补成标签（不拉起进程） ----
store.getState().reset();
// A 运行（刚被恢复/新建），B、C 同项目但停止 → 都应有标签
store.getState().reconcile([pane('A', 'p1', true), pane('B', 'p1', false), pane('C', 'p1', false)], 'A');
views = store.getState().views;
check('布局丢失：聚焦项目所有 pane 都补成标签', allPaneIds(views), ['A', 'B', 'C']);
check('布局丢失：标签数 = 3', views.length, 3);

// ---- 场景八：只补当前聚焦项目，不把其它项目的停止态 pane 铺出来 ----
store.getState().reset();
store.getState().reconcile(
  [pane('A', 'p1', true), pane('B', 'p1', false), pane('C', 'p2', false)],
  'A',
);
views = store.getState().views;
check('只补聚焦项目：p2 的停止态 pane 不铺标签', allPaneIds(views), ['A', 'B']);

// ---- 场景九：停止态 pane 已在本项目视图中（布局保留）时不重复补标签 ----
store.getState().reset();
// 先建立 A、B 两个视图（都运行），再全部翻转为停止态，布局仍在
store.getState().reconcile([pane('A', 'p1', true)], null);
store.getState().splitPane('A', 'right', 'p1');
store.getState().reconcile([pane('A', 'p1', true), pane('B', 'p1', true)], null);
store.getState().reconcile([pane('A', 'p1', false), pane('B', 'p1', false)], 'A');
views = store.getState().views;
check('布局保留：停止态 pane 不重复开标签', views.length, 1);
check('布局保留：分屏内两个 pane 仍在同一标签', allPaneIds(views), ['A', 'B']);

// ---- 场景十：标签按创建顺序排序，最新恢复/新建的不能排到最前 ----
store.getState().reset();
// panes 数组顺序即创建顺序：A 最早、C 最晚；聚焦恢复 C（最晚）
store.getState().reconcile(
  [pane('A', 'p1', false), pane('B', 'p1', false), pane('C', 'p1', true)],
  'C',
);
views = store.getState().views;
check('恢复最晚创建的 pane：标签仍按创建顺序', allPaneIds(views), ['A', 'B', 'C']);

// ---- 场景十一：关闭激活标签后直接选中第一个标签，不经过倒数第二个 ----
store.getState().reset();
// 一次铺出 A、B、C 三个视图，并激活最后的 C
store.getState().reconcile(
  [pane('A', 'p1', true), pane('B', 'p1', true), pane('C', 'p1', true)],
  'C',
);
views = store.getState().views;
const firstViewId = views[0].id;
const lastViewId = views[views.length - 1].id;
check('关闭前视图数 = 3', views.length, 3);
store.getState().closeView(lastViewId);
views = store.getState().views;
check('关闭激活的最后一个标签：视图数变为 2', views.length, 2);
check('关闭激活的最后一个标签：直接选中第一个标签', store.getState().activeViewId, firstViewId);

// ---- 场景十二：newEmptyView 创建空位视图，viewProjectId 取空位项目 ----
store.getState().reset();
store.getState().reconcile([pane('A', 'p1', true)], 'A');
store.getState().newEmptyView('p1');
views = store.getState().views;
check('newEmptyView 后视图数 = 2', views.length, 2);
check('newEmptyView 激活新空位视图', store.getState().activeViewId, views[views.length - 1].id);
const emptyView = views[views.length - 1];
check('空位视图无 pane 叶子', collectPanes(emptyView.tree), []);
check('空位视图的 projectId 取自空位', viewProjectId(emptyView, new Map()), 'p1');
// 空位视图能通过 reconcile 存活（空位被保留，不被剪掉）
store.getState().reconcile([pane('A', 'p1', true)], 'A');
views = store.getState().views;
check('reconcile 后空位视图仍保留', views.length, 2);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
