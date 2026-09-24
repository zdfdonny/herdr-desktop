/**
 * i18n —— 轻量类型安全的多语言支持（中文 / English）。
 *
 * 设计取舍：
 * - 不引入 i18next 等库：本应用文案量小，且需要「缺翻译时编译期报错」的强约束。
 * - 以中文为基准定义 `Messages` 接口，英文表实现同一接口，
 *   因此任何漏翻、拼错的 key 都会在 tsc 阶段暴露。
 * - 支持 `{name}` 占位符插值。
 */

import type { Language } from '@shared/state';

export const LANGUAGES: Language[] = ['zh-CN', 'en'];

/** 语言在界面上的显示名（用该语言自身书写，避免用户看不懂）。 */
export const LANGUAGE_LABELS: Record<Language, string> = {
  'zh-CN': '简体中文',
  en: 'English',
};

/** 文案表结构 —— 中文表是基准。 */
export interface Messages {
  app: {
    name: string;
  };
  sidebar: {
    projects: string;
    addProject: string;
    collapse: string;
    expand: string;
    newAgent: string;
    removeProject: string;
    removeProjectConfirm: string;
    expandProject: string;
    collapseProject: string;
  };
  agent: {
    notInstalled: string;
    terminal: string;
    close: string;
    /** 恢复出的（进程已死的）agent 行的悬停提示。 */
    stopped: string;
    /** 可用性探测进行中。 */
    probing: string;
    /** 没有探测到任何可用智能体。 */
    noneInstalled: string;
    /** 状态通知：agent 等待输入。 */
    notifyBlocked: string;
    /** 状态通知：agent 已完成。 */
    notifyDone: string;
  };
  pane: {
    /** 停止态终端区域的主标题。 */
    stoppedTitle: string;
    /** 停止态终端区域的说明文字。 */
    stoppedHint: string;
    /** 重新启动按钮。 */
    restart: string;
    /** scrollback 搜索占位符。 */
    searchPlaceholder: string;
    /** 搜索上一个。 */
    searchPrev: string;
    /** 搜索下一个。 */
    searchNext: string;
    /** 关闭搜索。 */
    searchClose: string;
    /** 分屏按钮。 */
    split: string;
    /** 向左分屏。 */
    splitLeft: string;
    /** 向右分屏。 */
    splitRight: string;
    /** 向上分屏。 */
    splitUp: string;
    /** 向下分屏。 */
    splitDown: string;
    /** 分屏后空位标题。 */
    emptySlotTitle: string;
    /** 取消分屏（关闭空位）。 */
    emptySlotCancel: string;
  };
  view: {
    /** 视图标签没有可显示标题时的兜底文案。 */
    empty: string;
    /** 关闭视图标签。 */
    close: string;
  };
  status: {
    idle: string;
    working: string;
    blocked: string;
    done: string;
    unknown: string;
  };
  theme: {
    system: string;
    light: string;
    dark: string;
  };
  empty: {
    addProjectTitle: string;
    selectAgentTitle: string;
    addProject: string;
    newAgent: string;
  };
  settings: {
    title: string;
    search: string;
    noResults: string;
    general: string;
    theme: string;
    themeHint: string;
    fontSize: string;
    fontSizeHint: string;
    language: string;
    languageHint: string;
    proxy: string;
    proxyUrl: string;
    proxyUrlHint: string;
    proxyPlaceholder: string;
    proxyAgents: string;
    proxyAgentsHint: string;
    proxyTest: string;
    proxyTesting: string;
    proxyTestOk: string;
    proxyTestInvalid: string;
    proxyTestBadIp: string;
    proxyTestUnsupported: string;
    proxyTestMissingPort: string;
    proxyTestTimeout: string;
    proxyTestFailed: string;
    proxyTestAuth: string;
    agents: string;
    installed: string;
    notInstalled: string;
    about: string;
    version: string;
    platform: string;
    dataDir: string;
    reset: string;
    resetHint: string;
    resetConfirm: string;
  };
  error: {
    commandNotFound: string;
    spawnFailed: string;
    noProject: string;
    noProjectDetail: string;
    projectNotFound: string;
    projectNotFoundDetail: string;
    dismiss: string;
  };
  common: {
    confirm: string;
    cancel: string;
    close: string;
  };
}

const zhCN: Messages = {
  app: {
    name: 'Herdr',
  },
  sidebar: {
    projects: '项目',
    addProject: '添加项目',
    collapse: '折叠侧栏',
    expand: '展开侧栏',
    newAgent: '在此项目新建智能体',
    removeProject: '移除项目',
    removeProjectConfirm: '确定移除项目「{name}」及其下的所有智能体？',
    expandProject: '展开项目',
    collapseProject: '折叠项目',
  },
  agent: {
    notInstalled: '未安装',
    terminal: '终端',
    close: '关闭',
    stopped: '已停止 — 点击启动',
    probing: '正在检测…',
    noneInstalled: '没有可用的智能体',
    notifyBlocked: '「{name}」等待输入',
    notifyDone: '「{name}」已完成',
  },
  pane: {
    stoppedTitle: '智能体已停止',
    stoppedHint:
      '应用重启后进程不会自动恢复。点击下方按钮，或在左侧列表中点击该智能体即可启动。',
    restart: '重新启动',
    searchPlaceholder: '搜索终端历史',
    searchPrev: '上一个',
    searchNext: '下一个',
    searchClose: '关闭搜索',
    split: '拆分',
    splitLeft: '向左拆分',
    splitRight: '向右拆分',
    splitUp: '向上拆分',
    splitDown: '向下拆分',
    emptySlotTitle: '选择要在该区域创建的智能体',
    emptySlotCancel: '取消拆分',
  },
  view: {
    empty: '新视图',
    close: '关闭视图',
  },
  status: {
    idle: '空闲',
    working: '运行中',
    blocked: '等待输入',
    done: '已完成',
    unknown: '未知',
  },
  theme: {
    system: '跟随系统',
    light: '浅色',
    dark: '深色',
  },
  empty: {
    addProjectTitle: '添加一个项目开始使用',
    selectAgentTitle: '选择一个智能体',
    addProject: '添加项目',
    newAgent: '新建智能体',
  },
  settings: {
    title: '设置',
    search: '搜索设置',
    noResults: '没有匹配的设置项',
    general: '通用',
    theme: '主题',
    themeHint: '默认跟随系统外观',
    fontSize: '终端字号',
    fontSizeHint: '取值范围 9 - 24 px',
    language: '语言',
    languageHint: '切换界面显示语言',
    proxy: '代理',
    proxyUrl: '代理地址',
    proxyUrlHint: '例如 http://127.0.0.1:7890，留空则不注入',
    proxyPlaceholder: 'http://127.0.0.1:7890',
    proxyAgents: '按智能体启用',
    proxyAgentsHint: '开启的智能体在启动时注入上面的代理，本地回环地址不走代理',
    proxyTest: '检测',
    proxyTesting: '检测中…',
    proxyTestOk: '代理可用（{ms} ms）',
    proxyTestInvalid: '地址格式不正确',
    proxyTestBadIp: 'IP 地址不正确，请检查是否为 127.0.0.1 这类合法地址',
    proxyTestUnsupported: '暂不支持该协议，请使用 http:// 或 https://',
    proxyTestMissingPort: '地址缺少端口号',
    proxyTestTimeout: '连接超时，代理未响应',
    proxyTestFailed: '无法通过该代理建立连接',
    proxyTestAuth: '代理要求身份验证（407）',
    agents: '智能体',
    installed: '已安装',
    notInstalled: '未安装',
    about: '关于',
    version: '版本',
    platform: '平台',
    dataDir: '数据目录',
    reset: '重新扫描',
    resetHint: '重新检测本机已安装的智能体',
    resetConfirm: '确定重新扫描本机的智能体命令？',
  },
  error: {
    commandNotFound: '命令不存在',
    spawnFailed: '启动智能体失败',
    noProject: '未选择项目',
    noProjectDetail: '请先添加一个项目，再创建智能体。',
    projectNotFound: '项目不存在',
    projectNotFoundDetail: '项目 {id} 已不可用。',
    dismiss: '关闭提示',
  },
  common: {
    confirm: '确定',
    cancel: '取消',
    close: '关闭',
  },
};

const en: Messages = {
  app: {
    name: 'Herdr',
  },
  sidebar: {
    projects: 'Projects',
    addProject: 'Add project',
    collapse: 'Collapse sidebar',
    expand: 'Expand sidebar',
    newAgent: 'New agent in this project',
    removeProject: 'Remove project',
    removeProjectConfirm: 'Remove project "{name}" and all of its agents?',
    expandProject: 'Expand project',
    collapseProject: 'Collapse project',
  },
  agent: {
    notInstalled: 'not installed',
    terminal: 'Terminal',
    close: 'Close',
    stopped: 'Stopped — click to start',
    probing: 'Detecting…',
    noneInstalled: 'No available agents',
    notifyBlocked: '"{name}" needs your input',
    notifyDone: '"{name}" finished',
  },
  pane: {
    stoppedTitle: 'Agent stopped',
    stoppedHint:
      'Processes do not survive an app restart. Click the button below — or the agent in the sidebar — to start it.',
    restart: 'Restart',
    searchPlaceholder: 'Search terminal history',
    searchPrev: 'Previous',
    searchNext: 'Next',
    searchClose: 'Close search',
    split: 'Split',
    splitLeft: 'Split left',
    splitRight: 'Split right',
    splitUp: 'Split up',
    splitDown: 'Split down',
    emptySlotTitle: 'Choose an agent for this area',
    emptySlotCancel: 'Cancel split',
  },
  view: {
    empty: 'New view',
    close: 'Close view',
  },
  status: {
    idle: 'Idle',
    working: 'Working',
    blocked: 'Blocked',
    done: 'Done',
    unknown: 'Unknown',
  },
  theme: {
    system: 'System',
    light: 'Light',
    dark: 'Dark',
  },
  empty: {
    addProjectTitle: 'Add a project to get started',
    selectAgentTitle: 'Select an agent',
    addProject: 'Add project',
    newAgent: 'New agent',
  },
  settings: {
    title: 'Settings',
    search: 'Search settings',
    noResults: 'No matching settings',
    general: 'General',
    theme: 'Theme',
    themeHint: 'Follows the system by default',
    fontSize: 'Terminal font size',
    fontSizeHint: 'Between 9 and 24 px',
    language: 'Language',
    languageHint: 'Change the interface language',
    proxy: 'Proxy',
    proxyUrl: 'Proxy URL',
    proxyUrlHint: 'For example http://127.0.0.1:7890; leave empty to disable',
    proxyPlaceholder: 'http://127.0.0.1:7890',
    proxyAgents: 'Per-agent',
    proxyAgentsHint: 'Enabled agents get the proxy at launch; loopback traffic bypasses it',
    proxyTest: 'Test',
    proxyTesting: 'Testing…',
    proxyTestOk: 'Proxy works ({ms} ms)',
    proxyTestInvalid: 'Invalid address format',
    proxyTestBadIp: 'Invalid IP address — check for something like 127.0.0.1',
    proxyTestUnsupported: 'Unsupported protocol; use http:// or https://',
    proxyTestMissingPort: 'Address is missing a port',
    proxyTestTimeout: 'Timed out; the proxy did not respond',
    proxyTestFailed: 'Could not connect through this proxy',
    proxyTestAuth: 'Proxy requires authentication (407)',
    agents: 'Agent',
    installed: 'Installed',
    notInstalled: 'Not installed',
    about: 'About',
    version: 'Version',
    platform: 'Platform',
    dataDir: 'Data directory',
    reset: 'Rescan',
    resetHint: 'Re-detect agents installed on this machine',
    resetConfirm: 'Rescan for agent commands on this machine?',
  },
  error: {
    commandNotFound: 'Command not found',
    spawnFailed: 'Failed to start agent',
    noProject: 'No project selected',
    noProjectDetail: 'Add a project before creating an agent.',
    projectNotFound: 'Project not found',
    projectNotFoundDetail: 'Project {id} is no longer available.',
    dismiss: 'Dismiss',
  },
  common: {
    confirm: 'Confirm',
    cancel: 'Cancel',
    close: 'Close',
  },
};

export const CATALOGS: Record<Language, Messages> = {
  'zh-CN': zhCN,
  en,
};

/** 取值路径，如 `'sidebar.addProject'`。 */
type LeafPath<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? P extends ''
      ? K
      : `${P}.${K}`
    : LeafPath<T[K], P extends '' ? K : `${P}.${K}`>;
}[keyof T & string];

export type MessageKey = LeafPath<Messages>;

/** 按路径取文案。 */
function lookup(messages: Messages, key: string): string | undefined {
  const parts = key.split('.');
  let node: unknown = messages;
  for (const part of parts) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * 翻译函数。
 *
 * @param language 目标语言
 * @param key      文案路径
 * @param vars     插值变量，如 `{ count: 3 }` 替换 `{count}`
 */
export function translate(
  language: Language,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const raw = lookup(CATALOGS[language], key) ?? lookup(CATALOGS['zh-CN'], key) ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;
