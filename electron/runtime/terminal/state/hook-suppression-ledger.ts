/**
 * hook 上报抑制账本 —— 「这个来源的上报为什么暂时不算数」。
 *
 * 从 `TerminalState` 抽出的第三个协作对象。原先是一张裸 Map + 分散在 7 个方法里的
 * 「读取 → 就地改写 → 写回」模式，导致 `pendingReplacementReport.seq` 必须单调这条
 * 不变量只能靠每个写点自觉维护。收进本类后，写点变成有名字的语义操作，
 * 不变式由这里统一保证。
 *
 * 为什么要抑制：全生命周期 hook（opencode / kimi / pi / omp / mastracode / kilo）
 * 在会话切换或进程退出后，可能还在用旧会话引用上报。直接把这类上报丢掉会让状态
 * 永远停在旧值，所以先记账（记来源、记原因、记替换后的会话），
 * 等来源真正换到新会话再放行（见 `route()`）。
 */

import type { AgentSessionRef } from './agent-session-ref';
import { sessionRefEquals } from './agent-session-ref';
import type { HookAuthority } from './hook-authority';

/** 抑制原因：会话被清空（hook-clear）还是进程退出（process-exit）。 */
export type SuppressionReason = 'hook-clear' | 'process-exit';

/** 一条待确认的替换上报（seq 用于丢弃乱序投递的旧上报）。 */
export interface PendingReplacementReport {
  authority: HookAuthority;
  seq: number;
}

/** 一条抑制记录。 */
export interface SuppressionEntry {
  agentLabel: string;
  /** 被抑制时锚定的会话（替换后要与之比较）。 */
  sessionRef: AgentSessionRef | null;
  observedAt: number;
  reason: SuppressionReason;
  /** 已确认替换到的会话（非 null 表示这条抑制已经「知道新会话是谁」）。 */
  replacementSessionRef: AgentSessionRef | null;
  /** 尚未确认的替换上报（等来源自己报出新会话后才落地）。 */
  pendingReplacementReport: PendingReplacementReport | null;
}

/** 路由结果：收还是不收；收的话要不要重置 seq 水位。 */
export type HookReportRoute = { accept: true; reanchorSequence: boolean } | { accept: false };

export class HookSuppressionLedger {
  private readonly entries = new Map<string, SuppressionEntry>();

  /** 读一条记录（只读用途，修改请走下面的语义方法）。 */
  get(source: string): SuppressionEntry | undefined {
    return this.entries.get(source);
  }

  has(source: string): boolean {
    return this.entries.has(source);
  }

  /** 全部记录（清理与诊断用）。 */
  all(): Array<[string, SuppressionEntry]> {
    return [...this.entries];
  }

  /** 全部记录的值（遍历判定用）。 */
  values(): SuppressionEntry[] {
    return [...this.entries.values()];
  }

  /**
   * 记一条抑制。
   *
   * 已存在时**原地更新**锚定信息（保留 pending 与 replacement），因为同一次
   * 抑制可能被多次触发（例如进程退出后再收到 clearance），语义上仍是同一条记录。
   */
  suppress(
    source: string,
    params: {
      agentLabel: string;
      sessionRef: AgentSessionRef | null;
      observedAt: number;
      reason: SuppressionReason;
    },
  ): SuppressionEntry {
    const existing = this.entries.get(source);
    if (existing) {
      existing.agentLabel = params.agentLabel;
      existing.observedAt = params.observedAt;
      existing.reason = params.reason;
      return existing;
    }
    const created: SuppressionEntry = {
      agentLabel: params.agentLabel,
      sessionRef: params.sessionRef,
      observedAt: params.observedAt,
      reason: params.reason,
      replacementSessionRef: null,
      pendingReplacementReport: null,
    };
    this.entries.set(source, created);
    return created;
  }

  /**
   * 整条覆盖写一条抑制记录（丢弃已有的 pending / replacement）。
   *
   * 与 `suppress()` 的区别：这里是有意的「重新开始」——调用方语义是
   * 「把这条来源的抑制状态重置为刚观察到的事实」，不存在可继承的待确认替换。
   */
  replace(
    source: string,
    params: {
      agentLabel: string;
      sessionRef: AgentSessionRef | null;
      observedAt: number;
      reason: SuppressionReason;
    },
  ): void {
    this.entries.set(source, {
      agentLabel: params.agentLabel,
      sessionRef: params.sessionRef,
      observedAt: params.observedAt,
      reason: params.reason,
      replacementSessionRef: null,
      pendingReplacementReport: null,
    });
  }

  /**
   * 记一条**待确认**的替换上报。
   *
   * 不变式：同一来源只保留 seq 更大的那条 —— 迟到的旧上报不能覆盖新的。
   * 这是原先散在调用点、靠人工维护的约束，现在由本方法保证。
   */
  rememberPendingReplacement(
    source: string,
    params: {
      agentLabel: string;
      sessionRef: AgentSessionRef | null;
      observedAt: number;
      reason: SuppressionReason;
      authority: HookAuthority;
      seq: number;
    },
  ): void {
    const entry = this.suppress(source, {
      agentLabel: params.agentLabel,
      sessionRef: params.sessionRef,
      observedAt: params.observedAt,
      reason: params.reason,
    });
    if (
      entry.pendingReplacementReport !== null &&
      params.seq <= entry.pendingReplacementReport.seq
    ) {
      return;
    }
    entry.pendingReplacementReport = { authority: params.authority, seq: params.seq };
  }

  /** 确认替换到某个会话：清掉 pending，写下替换后的锚点。 */
  confirmReplacement(source: string, sessionRef: AgentSessionRef): void {
    const entry = this.entries.get(source);
    if (!entry) return;
    entry.replacementSessionRef = sessionRef;
    entry.pendingReplacementReport = null;
  }

  /**
   * 确认替换到某个会话，但**仅当它与当前锚定值不同**时。
   *
   * 与原实现保持一致：避免同一会话重复上报时把 pending 无谓清掉；
   * 且只有 pending 指向的是**另一个**会话时才丢弃它（指向同一会话的 pending 仍然有效）。
   */
  confirmReplacementIfChanged(source: string, sessionRef: AgentSessionRef): void {
    const entry = this.entries.get(source);
    if (!entry) return;
    if (sessionRefEquals(entry.replacementSessionRef, sessionRef)) return;
    if (
      entry.pendingReplacementReport !== null &&
      !sessionRefEquals(entry.pendingReplacementReport.authority.sessionRef, sessionRef)
    ) {
      entry.pendingReplacementReport = null;
    }
    entry.replacementSessionRef = sessionRef;
  }

  /** 丢弃（来源已换到新会话、或记录过期）。 */
  forget(source: string): void {
    this.entries.delete(source);
  }

  /** 该来源的抑制是否指向「同一会话」且尚未被替换覆盖。 */
  isAnchoredTo(source: string, sessionRef: AgentSessionRef | null): boolean {
    const entry = this.entries.get(source);
    if (!entry) return false;
    return sessionRefEquals(entry.sessionRef, sessionRef);
  }

  /** 清空（进程退出 / 运行时身份重建）。 */
  clear(): void {
    this.entries.clear();
  }
}
