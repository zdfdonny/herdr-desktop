/**
 * 智能体描述符 —— 一个智能体的全部静态事实。
 *
 * 纯数据 + 纯函数，零 Node 依赖，因此主进程与渲染进程共用同一份定义：
 * 渲染端不再手写第二份 agent 目录（重构前 `src/stores/agentsStore.ts:53` 有 26 条），
 * 两侧从此不可能漂移。
 *
 * 约定：**数据能表达的放这里，行为有差异的才写子类**
 * （见 `electron/agents/core/agent.ts`）。19 个智能体里有 11 个的集成安装
 * 只用这份声明就够，不需要额外代码。
 */

import type { AgentId } from './agent-id';
import type { DetectionSpec } from './spec/detection-spec';
import type { HostEnv } from './spec/host';
import type { IntegrationSpec } from './spec/integration-spec';
import type { StatePolicy } from './spec/policy';
import type { ResumeSpec } from './spec/resume-spec';

/** pane 宿主形态。 */
export type AgentHosting = 'pty' | 'web';

export interface AgentDescriptor {
  readonly id: AgentId;
  /**
   * 识别优先级：数字**小的先匹配**。
   *
   * `detectAgentName` 按此顺序逐条试 `detection.identity`，第一个命中的即判定为该 agent。
   * 优先级必须显式声明，而不是靠 `DESCRIPTORS` 数组的位置 —— 否则新增智能体时
   * 「插到哪一行」会隐式改变其它智能体的识别结果，属于跨 agent 的隐式耦合。
   *
   * 取值约定：以 10 为步长留出插入空间（10 / 20 / 30 …）。
   * 相同值时按 id 字典序决定先后（`registry` 里做稳定排序）。
   */
  readonly detectionPriority: number;

  /** 展示名（品牌名，不翻译，渲染端直接显示）。 */
  readonly label: string;

  /** 启动命令（按平台解析：cursor 在 Windows 上是 `cursor-agent.cmd`）。 */
  readonly command: (host: HostEnv) => string;

  /**
   * 启动命令的默认附加参数。
   *
   * 用于记录「这个 pane 是怎么被拉起来的」，供会话恢复重放。
   * 例：dsh 是 web 型，实际启动命令是 `dsh web`，所以 `launchArgs: ['web']`。
   */
  readonly launchArgs?: readonly string[];

  /** pane 宿主形态，默认 `'pty'`。 */
  readonly hosting?: AgentHosting;

  /** 屏幕检测声明；缺省表示没有专属屏幕规则。 */
  readonly detection?: DetectionSpec;

  /** 官方集成声明；缺省表示不支持集成。 */
  readonly integration?: IntegrationSpec;

  /** 会话恢复声明；缺省表示不支持恢复。 */
  readonly resume?: ResumeSpec;

  /** 状态仲裁策略。 */
  readonly policy: StatePolicy;
}
