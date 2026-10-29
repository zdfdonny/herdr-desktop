/**
 * 陈旧会话登记表 —— 「这个会话已经作废，别再把它当成当前会话」。
 *
 * 从 `TerminalState` 抽出的第二个协作对象（第一个是 `HookReportSequence`）。
 *
 * 解决的问题：全生命周期 hook（opencode / kimi / pi / omp / mastracode / kilo）
 * 在会话切换后可能仍在用旧会话引用上报。若不记住哪些会话已作废，
 * 一条迟到的旧会话上报会把 pane 重新绑回上一个对话，重启后恢复错内容。
 *
 * 数据结构选型：按来源分组的列表（不是 Map），因为同一来源可能同时有多个作废会话
 * （用户连续 select 切换两次）。条目按 agentLabel + sessionRef 去重。
 */

import type { AgentSessionRef } from './agent-session-ref';
import { sessionRefEquals } from './agent-session-ref';

/** 一条作废的会话记录。 */
export interface StaleSession {
  agentLabel: string;
  sessionRef: AgentSessionRef;
}

export class StaleSessionRegistry {
  /** 来源 → 该来源下已作废的会话（可能多条）。 */
  private readonly bySource = new Map<string, StaleSession[]>();

  /** 记一个作废会话（幂等：同 agentLabel + 同引用不会重复入列）。 */
  remember(source: string, agentLabel: string, sessionRef: AgentSessionRef): void {
    const list = this.bySource.get(source);
    if (list === undefined) {
      this.bySource.set(source, [{ agentLabel, sessionRef }]);
      return;
    }
    if (list.some((e) => e.agentLabel === agentLabel && sessionRefEquals(e.sessionRef, sessionRef))) {
      return;
    }
    list.push({ agentLabel, sessionRef });
  }

  /** 移除一条作废记录（会话被重新认领时）。列表空了就把整组删掉，避免空数组堆积。 */
  forget(source: string, agentLabel: string, sessionRef: AgentSessionRef): void {
    const list = this.bySource.get(source);
    if (list === undefined) return;
    const kept = list.filter(
      (e) => !(e.agentLabel === agentLabel && sessionRefEquals(e.sessionRef, sessionRef)),
    );
    if (kept.length === 0) {
      this.bySource.delete(source);
    } else {
      this.bySource.set(source, kept);
    }
  }

  /** 这条上报的会话是否已被标记作废。 */
  has(source: string, agentLabel: string, sessionRef: AgentSessionRef | null): boolean {
    const list = this.bySource.get(source);
    if (list === undefined || sessionRef === null) return false;
    return list.some(
      (stale) => stale.agentLabel === agentLabel && sessionRefEquals(sessionRef, stale.sessionRef),
    );
  }

  /**
   * 该来源是否出现过这个 agent 的作废会话，**且当前这条引用不在作废名单里**。
   *
   * 用途：作废过 A 之后收到 B，说明 B 是切换后的新会话，应当被接受；
   * 若只判断 `has()`，B 会被当成「凭空出现的会话」拒掉。
   */
  isFreshAfterStale(
    source: string,
    agentLabel: string,
    sessionRef: AgentSessionRef | null,
  ): boolean {
    const list = this.bySource.get(source);
    if (list === undefined || sessionRef === null) return false;
    return (
      list.some((stale) => stale.agentLabel === agentLabel) &&
      list.every(
        (stale) => stale.agentLabel !== agentLabel || !sessionRefEquals(sessionRef, stale.sessionRef),
      )
    );
  }

  /** 全部记录的展开视图（进程退出清理、会话结算时遍历用）。 */
  entries(): Array<{ source: string } & StaleSession> {
    const out: Array<{ source: string } & StaleSession> = [];
    for (const [source, list] of this.bySource) {
      for (const stale of list) out.push({ source, ...stale });
    }
    return out;
  }

  /** 清空（进程退出 / 运行时身份重建）。 */
  clear(): void {
    this.bySource.clear();
  }

  /** 当前记录条数（诊断用）。 */
  get size(): number {
    let total = 0;
    for (const list of this.bySource.values()) total += list.length;
    return total;
  }
}
