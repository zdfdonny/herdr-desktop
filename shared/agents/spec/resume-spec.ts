/**
 * 会话恢复声明。
 *
 * 重构前，恢复命令是 `electron/runtime/agent-resume.ts:312` 的一个 18 分支
 * `switch (agent)`，白名单是另一张 19 条的表，会话替换允许表又是第三张 32 条的表 ——
 * 三张表都要同步改。现在每个智能体在自己 descriptor 里声明一次。
 */

import type { AgentSessionRefKind } from '../../state';

/** 会话引用（id 或文件路径）。 */
export interface AgentSessionRefLike {
  readonly kind: AgentSessionRefKind;
  readonly value: string;
}

export interface ResumeSpec {
  /**
   * 生成恢复命令的参数尾（不含 argv[0]）。
   *
   * 返回 null 表示「这个引用对该 agent 不可用于恢复」。
   */
  readonly tail: (ref: AgentSessionRefLike) => string[] | null;

  /**
   * session 引用优先用文件路径（pi / omp）。
   *
   * 这两个 agent 的会话既可以是 id 也可以是文件，上报时优先取 path。
   */
  readonly prefersPathRef?: boolean;

  /**
   * 允许「会话替换」的启动来源白名单（`sessionStartSource`）。
   *
   * 缺省表示不允许任何来源触发替换。对应重构前的
   * `agent-resume.ts:139` 的 `SESSION_REPLACEMENT_ALLOWED`。
   */
  readonly replacementSources?: readonly string[];

  /**
   * 从启动参数反推会话引用（目前只有 codex 的 `codex resume <id>`）。
   */
  readonly fromLaunchArgs?: (args: readonly string[]) => AgentSessionRefLike | null;
}

/** 不支持恢复的智能体。 */
export const NO_RESUME: ResumeSpec = {
  tail: () => null,
};

/** `--resume <id>` 形态（两个 argv 元素）。 */
export function spacedTail(flag: string): ResumeSpec['tail'] {
  return (ref) => (ref.kind === 'id' ? [flag, ref.value] : null);
}

/** `--resume=<id>` 形态（单个 argv 元素）。 */
export function joinedTail(flag: string): ResumeSpec['tail'] {
  return (ref) => (ref.kind === 'id' ? [`${flag}=${ref.value}`] : null);
}
