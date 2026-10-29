/**
 * 屏幕检测声明。
 *
 * 一个智能体「怎么从终端快照认出自己、怎么判定状态」全在这里声明。
 * 规则本身仍是纯数据（`AgentManifest`），由通用引擎求值 —— 不写成方法，
 * 因为规则需要能被表格驱动测试逐条断言。
 */

import type { AgentManifest, DetectionInput } from '../../detect/engine';

/** 额外的 region 解析器：把 agent 私有的屏幕结构概念挡在通用引擎之外。 */
export type RegionResolver = (input: DetectionInput) => string;

export interface DetectionSpec {
  /**
   * 识别该智能体用的正则**源码**（不带 flags，匹配时统一加 `i`）。
   *
   * 存源码而非 `RegExp` 实例，一是避免全局标志带来的 `lastIndex` 状态，
   * 二是让声明顺序（= 识别优先级）成为唯一需要关心的顺序问题。
   */
  readonly identity: string;

  /** 命令名别名 → 本智能体（如 `agy` / `antigravity-cli` → antigravity）。 */
  readonly aliases?: readonly string[];

  /**
   * 屏幕规则。
   *
   * 缺省表示没有专属 manifest：状态交给 hook 权威（omp / mastracode），
   * 或根本没有屏幕（dsh 是 web pane）。
   */
  readonly manifest?: AgentManifest;

  /**
   * 私有 region 解析器（默认为空）。
   *
   * codex 的 prompt 标记区域在这里实现，通用引擎不再认识 codex。
   */
  readonly regions?: Record<string, RegionResolver>;
}
