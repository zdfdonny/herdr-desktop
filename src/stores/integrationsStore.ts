/**
 * integrations store —— 官方集成 hook 的安装状态（跨组件共享）。
 *
 * 状态放在 store 而不是组件内部，是因为侧栏「集成」按钮的计数徽标必须在
 * **集成页未打开**时就可见：集成页与首次启动引导弹窗只读同一份状态，
 * 避免两处各自拉取后显示不一致。
 *
 * 状态权威来自 Main（getHookStatuses / installHook / uninstallHook）。
 */

import { create } from 'zustand';
import { getHookStatuses, installHook, uninstallHook } from '../ipc/client';
import { AGENT_PRESETS, isAvailable, useAgentsStore } from './agentsStore';
import { useNotificationStore } from './notificationStore';
import {
  countIntegrationUpdates,
  installableAgentIds,
  type HookStatusMap,
} from './integration-updates';

interface IntegrationsStore {
  /** agentId → installed/not-installed/unsupported/outdated。 */
  hookStatuses: HookStatusMap;
  /** 正在安装/卸载的 agentId（可以同时进行多个）。 */
  busy: string[];
  /** 是否正在执行「一键安装」。 */
  busyAll: boolean;
  /** 从 Main 拉取权威状态。 */
  refresh: () => Promise<void>;
  /** 安装（或更新）某个智能体的集成。 */
  install: (agentId: string) => Promise<void>;
  /** 卸载某个智能体的集成。 */
  uninstall: (agentId: string) => Promise<void>;
  /** 给所有本机可用的智能体安装集成，完成后重新拉取权威状态。 */
  installAll: () => Promise<void>;
}

/**
 * refresh 的单调请求号。
 *
 * 整表拉取有多个发起方（启动、面板/弹窗打开、单装/卸载后复核、一键安装后
 * 复核），IPC 往返时长不一：先发后到就会用旧快照覆盖新快照，徽标数字跟着
 * 跳回旧值。只接受最新一次请求的结果。
 */
let refreshSeq = 0;

/**
 * 某个 agentId 是否在本机可用。
 *
 * 与「一键安装」的目标筛选（installableAgentIds）用同一判据，保证
 * 「徽标数字」始终等于「集成页里能点的『更新』按钮个数」。
 * 未探测完成时 isAvailable 返回 true，所以启动瞬间徽标不会延迟出现。
 */
function isAgentLocallyAvailable(
  availability: Record<string, boolean>,
  probed: boolean,
  agentId: string,
): boolean {
  const preset = AGENT_PRESETS.find((p) => p.id === agentId);
  return preset ? isAvailable(availability, probed, preset.command) : false;
}

/** 安装/卸载失败时的错误提示（剥掉 Electron IPC 包装的错误前缀）。 */
function notifyFailure(agentId: string, error: unknown): void {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  useNotificationStore.getState().push({
    kind: 'error',
    titleKey: 'settings.integrationInstallFailed',
    titleVars: { agent: agentId },
    detailKey: 'settings.integrationInstallFailedDetail',
    detailVars: { error: message },
  });
}

export const useIntegrationsStore = create<IntegrationsStore>((set, get) => ({
  hookStatuses: {},
  busy: [],
  busyAll: false,

  refresh: async () => {
    const seq = ++refreshSeq;
    try {
      const statuses = await getHookStatuses();
      // 已经有更晚的请求发出：这份快照过期了，丢弃。
      if (seq !== refreshSeq) return;
      set({ hookStatuses: statuses });
    } catch {
      /*
       * 主进程尚未就绪：保持现有状态。空表不会显示徽标，
       * 因此这里静默即可，避免启动瞬间弹错误提示。
       */
    }
  },

  install: async (agentId) => {
    set((s) => ({ busy: [...s.busy, agentId] }));
    try {
      /*
       * 不写回 installHook 的单条返回值，只以 refresh 的权威状态为准：
       * 单条返回值只看 hook 文件是否存在，而 opencode / grok 还要额外检查
       * TUI 脚本与配置是否有效，可能仍被判为 outdated。写回会让徽标先按
       * 「装好了」减一（甚至消失），复核后再跳回来，看起来像「更新成功了
       * 又失败」——这正是 A3 要避免的闪烁，光靠 await 挡不住。
       *
       * 这里 await 而不是 void：让「进行中」覆盖到复核结束，按钮不会在
       * 状态还是旧值时就恢复可点。
       */
      await installHook(agentId);
      await get().refresh();
    } catch (error) {
      notifyFailure(agentId, error);
    } finally {
      set((s) => ({ busy: s.busy.filter((id) => id !== agentId) }));
    }
  },

  uninstall: async (agentId) => {
    set((s) => ({ busy: [...s.busy, agentId] }));
    try {
      /*
       * 与 install 同理：不写回 uninstallHook 的单条返回值，只以 refresh 的
       * 权威状态为准。uninstallHook 也不跑 opencode / grok 的额外校验，半失败
       * 的卸载会被写成 installed，而权威状态其实是 outdated —— 徽标会漏显示。
       */
      await uninstallHook(agentId);
      await get().refresh();
    } catch (error) {
      notifyFailure(agentId, error);
    } finally {
      set((s) => ({ busy: s.busy.filter((id) => id !== agentId) }));
    }
  },

  installAll: async () => {
    set({ busyAll: true });
    const { availability, probed } = useAgentsStore.getState();
    const agents = installableAgentIds(get().hookStatuses, (agentId) =>
      isAgentLocallyAvailable(availability, probed, agentId),
    );
    try {
      /*
       * 逐个安装、互不影响：失败的那个保持原状态即可，由下面的复核
       * 从 Main 拿权威结果（仍是旧版本的话就继续显示为待更新）。
       */
      await Promise.allSettled(agents.map((agentId) => installHook(agentId)));
      // 走 refresh 而不是直接 set：共用请求号，避免这次结果被更早发出的
      // 单条复核覆盖（那份快照可能还没反映刚刚装完的版本）。
      await get().refresh();
    } catch {
      /* 同步抛错等意外：保留现有状态，下次刷新再纠正 */
    } finally {
      set({ busyAll: false });
    }
  },
}));

/**
 * 待更新的集成数量（侧栏「集成」按钮计数徽标上的数字）。
 *
 * 只统计「本机可用且 outdated」的智能体，与集成页的可操作性对齐：
 * 数字等于集成页里能点的「更新」按钮个数，因此用户把所有更新都点完之后
 * 它一定能归零（徽标随之消失）——不可用的智能体在集成页里只显示「未找到」、
 * 没有任何按钮，若把它算进来，徽标就再也清不掉了。
 */
export function useIntegrationUpdateCount(): number {
  const statuses = useIntegrationsStore((s) => s.hookStatuses);
  const availability = useAgentsStore((s) => s.availability);
  const probed = useAgentsStore((s) => s.probed);
  return countIntegrationUpdates(statuses, (agentId) =>
    isAgentLocallyAvailable(availability, probed, agentId),
  );
}
