/**
 * layoutStore —— 用户可控的分屏布局树（纯 Renderer 状态）。
 *
 * 与 sessionStore 的分工：
 * - sessionStore 保存**结构事实**（哪些 pane 存在、谁是焦点），由 Main 推送；
 * - layoutStore 只保存**这些 pane 在屏幕上的排列**，因此不需要新增任何 IPC。
 *
 * 两层模型：
 * - View：一个独立视图，占满主区域，内部有自己的布局树。可以并存多个，
 *   同一时刻只有一个处于激活态（activeViewId），其余在标签栏里待切换。
 * - LayoutNode：单个视图内部的二叉树。
 *   - SplitNode：内部节点，沿 row（左/右）或 column（上/下）切成两份；
 *   - PaneLeaf：叶子，挂一个真实 pane；
 *   - EmptyLeaf：叶子，等待用户选择智能体填充的空位（分屏动作创建）。
 *
 * 创建 agent 的两条路径（职责分离）：
 * - 侧栏项目列表里新建 → 新开一个独立视图（不打扰当前视图的布局）；
 * - pane 标题栏的分屏按钮 → 在**当前视图内**按方向分屏。
 *
 * 与 Main 快照的同步靠 `reconcile`：
 * - 移除已不存在的 pane（折叠只剩单子节点的 split），视图空了就删掉视图；
 * - 用新出现的 pane 填充空位（优先 projectId 匹配）——这是分屏路径；
 * - 仍未被任何树接纳的新 pane → 各自新开一个视图并激活最后一个——这是侧栏路径。
 *
 * 布局持久化到 localStorage（按 paneId 引用），应用重启后只要会话里的 paneId
 * 还在（session.json 会恢复它们），视图与布局就能原样回来。
 */

import { create } from 'zustand';
import type { PaneState } from '@shared/state';

export type SplitOrientation = 'row' | 'column';
export type SplitDirection = 'left' | 'right' | 'up' | 'down';

export interface SplitNode {
  id: string;
  type: 'split';
  /** row = 左右并排，column = 上下堆叠。 */
  orientation: SplitOrientation;
  /** 第一个子节点的尺寸占比（0–100）。 */
  ratio: number;
  children: [LayoutNode, LayoutNode];
}

export interface PaneLeaf {
  id: string;
  type: 'pane';
  paneId: string;
}

export interface EmptyLeaf {
  id: string;
  type: 'empty';
  /** 该空位用于创建哪个项目的智能体。 */
  projectId: string;
}

export type LayoutNode = SplitNode | PaneLeaf | EmptyLeaf;

/**
 * 一个独立视图：占满主区域，内部有自己的布局树。
 * 多个视图并存时靠标签栏切换，同一时刻只有一个激活。
 */
export interface View {
  id: string;
  tree: LayoutNode | null;
}

/** 分隔条宽度（px），需与 components.css 中 .split-divider 的尺寸一致。 */
export const DIVIDER_SIZE = 4;

const STORAGE_KEY = 'herdr.layout.v2';

let nodeSeq = 0;
function nextId(): string {
  nodeSeq += 1;
  return `n${nodeSeq}-${Date.now().toString(36)}`;
}

function makeView(tree: LayoutNode | null): View {
  return { id: `v-${nextId()}`, tree };
}

function makePaneLeaf(pane: PaneState): PaneLeaf {
  return { id: nextId(), type: 'pane', paneId: pane.paneId };
}

function makeEmptyLeaf(projectId: string): EmptyLeaf {
  return { id: nextId(), type: 'empty', projectId };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/* ===== 纯树变换（无副作用，便于单元测试） ===== */

function collectPaneIds(node: LayoutNode | null, out: Set<string> = new Set()): Set<string> {
  if (!node) return out;
  if (node.type === 'pane') {
    out.add(node.paneId);
  } else if (node.type === 'split') {
    collectPaneIds(node.children[0], out);
    collectPaneIds(node.children[1], out);
  }
  return out;
}

function findPaneLeaf(node: LayoutNode | null, paneId: string): PaneLeaf | null {
  if (!node) return null;
  if (node.type === 'pane' && node.paneId === paneId) return node;
  if (node.type === 'split') {
    return findPaneLeaf(node.children[0], paneId) ?? findPaneLeaf(node.children[1], paneId);
  }
  return null;
}

/** 查找某个 split 节点（供分隔条拖拽读取 ratio）。 */
export function findSplitNode(root: LayoutNode | null, id: string): SplitNode | null {
  if (!root) return null;
  if (root.type === 'split') {
    if (root.id === id) return root;
    return findSplitNode(root.children[0], id) ?? findSplitNode(root.children[1], id);
  }
  return null;
}

function leftmostPaneId(node: LayoutNode | null): string | null {
  if (!node) return null;
  if (node.type === 'pane') return node.paneId;
  if (node.type === 'split') {
    return leftmostPaneId(node.children[0]) ?? leftmostPaneId(node.children[1]);
  }
  return null;
}

/**
 * 移除已不存在的 pane 叶子，并折叠只剩单子节点的 split。
 *
 * 折叠时若剩下的唯一子节点是**空位**，则连它一起丢掉：
 * 空位是「等待用户选择智能体」的占位，只有在和存活 pane 并排时才有意义。
 * 若保留，用户会看到一个孤零零的空位顶替了原来的分屏——分屏等于被静默撤销，
 * 而且该视图内已无任何真实 pane，标签栏还会出现一个没有标题的标签。
 */
function prune(node: LayoutNode | null, valid: Set<string>): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'pane') return valid.has(node.paneId) ? node : null;
  if (node.type === 'empty') return node;
  const a = prune(node.children[0], valid);
  const b = prune(node.children[1], valid);
  if (a && b) return { ...node, children: [a, b] };
  const survivor = a ?? b;
  // 兄弟 pane 消失后只剩空位：这个空位已无处安放，丢弃
  if (survivor && survivor.type === 'empty') return null;
  return survivor;
}

/** 用新 pane 填充空位。返回新树与被消费掉的 paneId。 */
function fillEmpty(
  node: LayoutNode | null,
  newPanes: PaneState[],
): { node: LayoutNode | null; used: Set<string> } {
  if (!node) return { node: null, used: new Set() };
  if (node.type === 'empty') {
    if (newPanes.length === 0) return { node, used: new Set() };
    const match = newPanes.find((p) => p.projectId === node.projectId) ?? newPanes[0];
    return { node: makePaneLeaf(match), used: new Set([match.paneId]) };
  }
  if (node.type === 'pane') return { node, used: new Set() };

  const left = fillEmpty(node.children[0], newPanes);
  const remaining = newPanes.filter((p) => !left.used.has(p.paneId));
  const right = fillEmpty(node.children[1], remaining);
  const used = new Set<string>([...left.used, ...right.used]);
  return {
    node: { ...node, children: [left.node!, right.node!] },
    used,
  };
}

/**
 * 跨视图填充空位：按视图顺序依次尝试，视图内按 projectId 匹配优先。
 * 返回新的视图数组与被消耗的 paneId 集合。
 */
function fillEmptyAcross(
  views: View[],
  newPanes: PaneState[],
): { views: View[]; used: Set<string> } {
  let pending = newPanes;
  const used = new Set<string>();
  const next = views.map((v) => {
    if (pending.length === 0) return v;
    const filled = fillEmpty(v.tree, pending);
    pending = pending.filter((p) => !filled.used.has(p.paneId));
    for (const id of filled.used) used.add(id);
    return { ...v, tree: filled.node };
  });
  return { views: next, used };
}

/** 把目标 pane 叶子沿 row 方向一分为二，新 pane 放在右侧。 */
function splitLeafRight(root: LayoutNode, targetPaneId: string, pane: PaneState): LayoutNode {
  if (root.type === 'pane' && root.paneId === targetPaneId) {
    return {
      id: nextId(),
      type: 'split',
      orientation: 'row',
      ratio: 50,
      children: [root, makePaneLeaf(pane)],
    };
  }
  if (root.type === 'split') {
    return {
      ...root,
      children: [
        splitLeafRight(root.children[0], targetPaneId, pane),
        splitLeafRight(root.children[1], targetPaneId, pane),
      ],
    };
  }
  return root;
}

/** 更新指定 split 节点的 ratio。 */
function setRatioAt(root: LayoutNode | null, nodeId: string, ratio: number): LayoutNode | null {
  if (!root) return null;
  if (root.type === 'split') {
    if (root.id === nodeId) return { ...root, ratio: clamp(ratio, 10, 90) };
    return {
      ...root,
      children: [
        setRatioAt(root.children[0], nodeId, ratio)!,
        setRatioAt(root.children[1], nodeId, ratio)!,
      ],
    };
  }
  return root;
}

/** 按方向把目标 pane 一分为二，新空位放在指定方向。 */
function splitAtPane(
  root: LayoutNode | null,
  paneId: string,
  direction: SplitDirection,
  projectId: string,
): LayoutNode | null {
  if (!root) return null;
  if (root.type === 'pane' && root.paneId === paneId) {
    const orientation: SplitOrientation =
      direction === 'left' || direction === 'right' ? 'row' : 'column';
    const empty = makeEmptyLeaf(projectId);
    const children: [LayoutNode, LayoutNode] =
      direction === 'left' || direction === 'up' ? [empty, root] : [root, empty];
    return { id: nextId(), type: 'split', orientation, ratio: 50, children };
  }
  if (root.type === 'split') {
    return {
      ...root,
      children: [
        splitAtPane(root.children[0], paneId, direction, projectId)!,
        splitAtPane(root.children[1], paneId, direction, projectId)!,
      ],
    };
  }
  return root;
}

/** 移除一个空位：其父 split 直接折叠为另一个子节点。 */
function removeEmptySlot(root: LayoutNode | null, slotId: string): LayoutNode | null {
  if (!root) return null;
  if (root.type === 'empty' && root.id === slotId) return null;
  if (root.type === 'split') {
    const a = root.children[0];
    const b = root.children[1];
    if (a.type === 'empty' && a.id === slotId) return b;
    if (b.type === 'empty' && b.id === slotId) return a;
    return {
      ...root,
      children: [
        removeEmptySlot(a, slotId)!,
        removeEmptySlot(b, slotId)!,
      ],
    };
  }
  return root;
}

/* ===== 展平为可渲染的矩形（供 SplitView 使用） ===== */

/** 叶子在容器中的矩形（0–1 比例），按类型判别联合。 */
export type FlatLeaf =
  | { key: string; type: 'pane'; paneId: string; x: number; y: number; w: number; h: number }
  | { key: string; type: 'empty'; projectId: string; x: number; y: number; w: number; h: number };

/** 分隔条在容器中的位置（0–1 比例）。 */
export interface FlatDivider {
  /** 稳定的 split 节点 id。 */
  key: string;
  nodeId: string;
  orientation: SplitOrientation;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 该 split 节点自身内容区矩形（用于拖拽时把像素增量换算回 ratio）。 */
  contentX: number;
  contentY: number;
  contentW: number;
  contentH: number;
}

export interface FlatLayout {
  leaves: FlatLeaf[];
  dividers: FlatDivider[];
}

/**
 * 把布局树展平成绝对定位的矩形列表。
 *
 * 展平的目的：让每个叶子都成为同一个容器的直接子节点，并用稳定的 key 保持
 * React 组件身份，避免布局变化（分屏/关闭/折叠）时存活 pane 的 xterm 被
 * 卸载重建（否则终端会闪烁、滚动位置复位）。
 */
export function flattenLayout(root: LayoutNode | null): FlatLayout {
  const out: FlatLayout = { leaves: [], dividers: [] };
  if (root) {
    walk(root, 0, 0, 1, 1, out);
  }
  return out;
}

function walk(
  node: LayoutNode,
  x: number,
  y: number,
  w: number,
  h: number,
  out: FlatLayout,
): void {
  if (node.type === 'pane') {
    out.leaves.push({ key: node.id, type: 'pane', paneId: node.paneId, x, y, w, h });
    return;
  }
  if (node.type === 'empty') {
    out.leaves.push({ key: node.id, type: 'empty', projectId: node.projectId, x, y, w, h });
    return;
  }

  const r = node.ratio / 100;
  if (node.orientation === 'row') {
    const leftW = w * r;
    out.dividers.push({
      key: node.id,
      nodeId: node.id,
      orientation: 'row',
      x: x + leftW,
      y,
      w: 0,
      h,
      contentX: x,
      contentY: y,
      contentW: w,
      contentH: h,
    });
    walk(node.children[0], x, y, leftW, h, out);
    walk(node.children[1], x + leftW, y, w - leftW, h, out);
  } else {
    const topH = h * r;
    out.dividers.push({
      key: node.id,
      nodeId: node.id,
      orientation: 'column',
      x,
      y: y + topH,
      w,
      h: 0,
      contentX: x,
      contentY: y,
      contentW: w,
      contentH: h,
    });
    walk(node.children[0], x, y, w, topH, out);
    walk(node.children[1], x, y + topH, w, h - topH, out);
  }
}

/* ===== 持久化 ===== */

function isValidTree(node: unknown): node is LayoutNode {
  if (!node || typeof node !== 'object') return false;
  const n = node as Record<string, unknown>;
  if (n.type === 'pane') {
    return typeof n.id === 'string' && typeof n.paneId === 'string';
  }
  if (n.type === 'empty') {
    return typeof n.id === 'string' && typeof n.projectId === 'string';
  }
  if (n.type === 'split') {
    return (
      typeof n.id === 'string' &&
      (n.orientation === 'row' || n.orientation === 'column') &&
      typeof n.ratio === 'number' &&
      Array.isArray(n.children) &&
      n.children.length === 2 &&
      isValidTree(n.children[0]) &&
      isValidTree(n.children[1])
    );
  }
  return false;
}

function isValidView(value: unknown): value is View {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && (v.tree === null || isValidTree(v.tree));
}

interface PersistedLayout {
  views: View[];
  activeViewId: string | null;
}

function loadLayout(): PersistedLayout {
  const empty: PersistedLayout = { views: [], activeViewId: null };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const p = parsed as Record<string, unknown>;
    const views = Array.isArray(p.views) ? p.views.filter(isValidView) : [];
    const activeViewId =
      typeof p.activeViewId === 'string' && views.some((v) => v.id === p.activeViewId)
        ? p.activeViewId
        : (views[0]?.id ?? null);
    return { views, activeViewId };
  } catch {
    return empty;
  }
}

function saveLayout(views: View[], activeViewId: string | null): void {
  try {
    if (views.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ views, activeViewId }));
  } catch {
    /* 存储不可用时静默忽略（布局只是便利，不影响功能） */
  }
}

/** 纯 UI 兜底：把一组 pane 排成一行。正常情况下 reconcile 会保证树存在。 */
export function buildRowTree(panes: PaneState[]): LayoutNode | null {
  if (panes.length === 0) return null;
  let root: LayoutNode = makePaneLeaf(panes[0]);
  for (let i = 1; i < panes.length; i++) {
    root = splitLeafRight(root, leftmostPaneId(root) ?? panes[i - 1].paneId, panes[i]);
  }
  return root;
}

/** 该视图是否还有存在意义（含空位，或含存活 pane）。 */
function viewHasContent(view: View, valid: Set<string>): boolean {
  let found = false;
  const scan = (node: LayoutNode | null): void => {
    if (!node || found) return;
    if (node.type === 'pane') {
      if (valid.has(node.paneId)) found = true;
      return;
    }
    if (node.type === 'empty') {
      found = true;
      return;
    }
    scan(node.children[0]);
    scan(node.children[1]);
  };
  scan(view.tree);
  return found;
}

interface LayoutStore {
  /** 所有独立视图；同一时刻只有一个激活。 */
  views: View[];
  activeViewId: string | null;
  /** 上次 reconcile 时可见 pane 集合的签名，用于跳过高频快照里的无变化重算。 */
  lastSignature: string;
  setRatio: (nodeId: string, ratio: number) => void;
  splitPane: (paneId: string, direction: SplitDirection, projectId: string) => void;
  closeEmptySlot: (slotId: string) => void;
  activateView: (viewId: string) => void;
  /** 激活包含指定 pane 的视图；找不到则忽略。返回是否命中。 */
  activateViewOfPane: (paneId: string) => boolean;
  closeView: (viewId: string) => void;
  reconcile: (panes: PaneState[], focusedPaneId: string | null) => void;
  reset: () => void;
}

function signature(panes: PaneState[]): string {
  return panes
    .map((p) => p.paneId)
    .sort()
    .join('\u0000');
}

/** 在 views 里定位包含某 pane 的视图。 */
function viewOfPane(views: View[], paneId: string): View | null {
  return views.find((v) => findPaneLeaf(v.tree, paneId) !== null) ?? null;
}

export const useLayoutStore = create<LayoutStore>((set, get) => {
  const initial = loadLayout();

  /** 统一的写入口：更新视图数组 + 激活项并落盘。 */
  const commit = (views: View[], activeViewId: string | null) => {
    saveLayout(views, activeViewId);
    set({ views, activeViewId });
  };

  return {
    views: initial.views,
    activeViewId: initial.activeViewId,
    lastSignature: '',

    setRatio: (nodeId, ratio) => {
      const { views, activeViewId } = get();
      const next = views.map((v) =>
        v.id === activeViewId ? { ...v, tree: setRatioAt(v.tree, nodeId, ratio) } : v,
      );
      commit(next, activeViewId);
    },

    splitPane: (paneId, direction, projectId) => {
      const { views, activeViewId } = get();
      const target = viewOfPane(views, paneId);
      if (!target) return;
      const next = views.map((v) =>
        v.id === target.id ? { ...v, tree: splitAtPane(v.tree, paneId, direction, projectId) } : v,
      );
      commit(next, activeViewId);
    },

    closeEmptySlot: (slotId) => {
      const { views, activeViewId } = get();
      const next: View[] = [];
      let nextActive = activeViewId;
      for (const v of views) {
        const tree = removeEmptySlot(v.tree, slotId);
        if (tree === null) {
          // 视图只剩这一个空位：连视图一起收掉
          if (nextActive === v.id) nextActive = null;
          continue;
        }
        next.push({ ...v, tree });
      }
      if (nextActive === null) nextActive = next[0]?.id ?? null;
      commit(next, nextActive);
    },

    activateView: (viewId) => {
      const { views, activeViewId } = get();
      if (activeViewId === viewId) return;
      if (!views.some((v) => v.id === viewId)) return;
      commit(views, viewId);
    },

    activateViewOfPane: (paneId) => {
      const { views, activeViewId } = get();
      const target = viewOfPane(views, paneId);
      if (!target || target.id === activeViewId) return target !== null;
      commit(views, target.id);
      return true;
    },

    closeView: (viewId) => {
      const { views, activeViewId } = get();
      const idx = views.findIndex((v) => v.id === viewId);
      if (idx < 0) return;
      const next = views.filter((v) => v.id !== viewId);
      let nextActive = activeViewId;
      if (activeViewId === viewId) {
        nextActive = next[idx]?.id ?? next[idx - 1]?.id ?? null;
      }
      commit(next, nextActive);
    },

    reconcile: (panes, focusedPaneId) => {
      const sig = signature(panes);
      const state = get();
      // 结构未变化时直接跳过：快照在终端每次输出时都会推来，这里必须廉价。
      if (sig === state.lastSignature && state.views.length > 0) return;

      let views = state.views;
      let activeViewId = state.activeViewId;
      const valid = new Set(panes.map((p) => p.paneId));

      // 1) 剪掉已消失的 pane（折叠只剩单子节点的 split），并丢弃空视图
      views = views
        .map((v) => ({ ...v, tree: prune(v.tree, valid) }))
        .filter((v) => viewHasContent(v, valid));

      if (activeViewId && !views.some((v) => v.id === activeViewId)) {
        activeViewId = null;
      }

      // 2) 已被任何视图接纳的 pane
      const placed = new Set<string>();
      for (const v of views) {
        for (const id of collectPaneIds(v.tree)) placed.add(id);
      }
      const newPanes = panes.filter((p) => !placed.has(p.paneId));

      // 3) 分屏路径：用新 pane 填充空位（优先 projectId 匹配），留在原视图内
      const filled = fillEmptyAcross(views, newPanes);
      views = filled.views;

      // 4) 侧栏路径：剩下没被任何空位接纳的新 pane → 各自新开一个独立视图
      const remaining = newPanes.filter((p) => !filled.used.has(p.paneId));
      const spawnedViewId = remaining.length > 0
        ? (() => {
            const created = remaining.map((p) => makeView(makePaneLeaf(p)));
            views = [...views, ...created];
            // 只激活最后一个：一次批量创建（如恢复会话）不该反复抢焦点
            return created[created.length - 1].id;
          })()
        : null;

      // 5) 有存活 pane 却没有任何视图（首次启动/布局丢失）：全部按新视图铺开
      if (views.length === 0 && panes.length > 0) {
        views = panes.map((p) => makeView(makePaneLeaf(p)));
        activeViewId = views[views.length - 1].id;
      } else if (spawnedViewId) {
        // 新建的视图优先于下面的焦点跟随：快照里的 focusedPaneId 可能仍是旧 pane
        activeViewId = spawnedViewId;
      }

      if (!activeViewId) activeViewId = views[0]?.id ?? null;

      // 聚焦的 pane 在别的视图里时（如侧栏点选），把那个视图带到前台。
      // 刚新开视图的那一轮跳过，避免焦点还没切过来就把新视图顶掉。
      if (focusedPaneId && !spawnedViewId) {
        const owner = viewOfPane(views, focusedPaneId);
        if (owner) activeViewId = owner.id;
      }

      saveLayout(views, activeViewId);
      set({ views, activeViewId, lastSignature: sig });
    },

    reset: () => {
      saveLayout([], null);
      set({ views: [], activeViewId: null, lastSignature: '' });
    },
  };
});
