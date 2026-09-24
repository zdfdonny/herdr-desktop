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
const { useLayoutStore } = await import(pathToFileURL(bundlePath).href);

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

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
