/**
 * SettingsDialog —— 设置弹窗。
 *
 * 左侧分类导航（图标 + 名称），右侧内容区，顶部搜索框，右上角关闭。
 *
 * 弹窗覆盖在主区域之上，终端在后台继续运行不中断。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThemePreference, Language } from '@shared/state';
import { useSettingsStore, useResolvedTheme } from '../stores/settingsStore';
import { useUiStore } from '../stores/uiStore';
import { useT } from '../i18n';
import { LANGUAGES, LANGUAGE_LABELS, type MessageKey } from '../i18n/messages';
import { AGENT_PRESETS, useAgentsStore, isAvailable } from '../stores/agentsStore';
import { getAppInfo, testProxy, getHookStatuses, installHook, uninstallHook } from '../ipc/client';
import type { ProxyTestResult, HookStatus } from '@shared/protocol';
import {
  IconSliders,
  IconGlobe,
  IconTerminal,
  IconInfo,
  IconSearch,
  IconClose,
} from './icons';

const THEME_OPTIONS: Array<{ value: ThemePreference; labelKey: MessageKey }> = [
  { value: 'system', labelKey: 'theme.system' },
  { value: 'light', labelKey: 'theme.light' },
  { value: 'dark', labelKey: 'theme.dark' },
];

const MIN_FONT = 9;
const MAX_FONT = 24;

type SectionId = 'general' | 'agents' | 'proxy' | 'about';

/**
 * 把检测结果翻译成用户可读文案。
 *
 * Main 只回结构化原因（reason/detail），本地化在这里完成，
 * 与「Main 不产出本地化文案」的约定一致。
 */
function describeProxyTest(result: ProxyTestResult, t: (key: MessageKey) => string): string {
  if (result.ok) {
    return t('settings.proxyTestOk').replace('{ms}', String(result.latencyMs ?? 0));
  }
  switch (result.reason) {
    case 'invalid':
      if (result.detail === 'bad-ip') return t('settings.proxyTestBadIp');
      if (result.detail === 'missing-port') return t('settings.proxyTestMissingPort');
      if (result.detail === 'socks5' || result.detail === 'socks4' || result.detail === 'socks') {
        return t('settings.proxyTestUnsupported');
      }
      return t('settings.proxyTestInvalid');
    case 'timeout':
      return t('settings.proxyTestTimeout');
    default:
      // 407：代理要求认证，单独提示，避免与「连不上」混淆
      if (result.detail === '407') return t('settings.proxyTestAuth');
      return t('settings.proxyTestFailed');
  }
}

interface Section {
  id: SectionId;
  Icon: (props: { size?: number }) => React.ReactElement;
  labelKey: MessageKey;
  /** 搜索索引：命中关键词才显示。 */
  keywords: string[];
}

const SECTIONS: Section[] = [
  {
    id: 'general',
    Icon: IconSliders,
    labelKey: 'settings.general',
    keywords: [
      'general',
      '通用',
      'theme',
      '主题',
      'appearance',
      '外观',
      'font',
      '字体',
      'language',
      '语言',
      'english',
      'chinese',
      '中文',
    ],
  },
  {
    id: 'agents',
    Icon: IconTerminal,
    labelKey: 'settings.agents',
    keywords: ['agent', '检测', 'detect', 'command', '命令'],
  },
  {
    id: 'proxy',
    Icon: IconGlobe,
    labelKey: 'settings.proxy',
    keywords: ['proxy', '代理', '网络', 'network', 'http', 'socks'],
  },
  {
    id: 'about',
    Icon: IconInfo,
    labelKey: 'settings.about',
    keywords: ['about', '关于', 'version', '版本', 'platform', '平台'],
  },
];

export function SettingsDialog() {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setProxyUrl = useSettingsStore((s) => s.setProxyUrl);
  const setAgentProxy = useSettingsStore((s) => s.setAgentProxy);
  const resolvedTheme = useResolvedTheme();
  const closeSettings = useUiStore((s) => s.closeSettings);

  const availability = useAgentsStore((s) => s.availability);
  const probed = useAgentsStore((s) => s.probed);
  const refreshAgents = useAgentsStore((s) => s.refresh);

  const [active, setActive] = useState<SectionId>('general');
  const [query, setQuery] = useState('');
  const [appInfo, setAppInfo] = useState<{ version: string; platform: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  /** 代理地址输入框，检测时读取其当前值（可能尚未失焦提交）。 */
  const proxyInputRef = useRef<HTMLInputElement>(null);
  /** 代理检测状态：null 表示尚未检测。 */
  const [proxyTest, setProxyTest] = useState<ProxyTestResult | null>(null);
  const [proxyTesting, setProxyTesting] = useState(false);
  /** 官方集成 hook 安装状态：agentId → installed/not-installed/unsupported。 */
  const [hookStatuses, setHookStatuses] = useState<Record<string, HookStatus>>({});
  const [hookBusy, setHookBusy] = useState<string | null>(null);
  const [hookBusyAll, setHookBusyAll] = useState(false);

  /*
   * 检测代理：先提交当前输入值（用户可能还没失焦），再发起检测。
   * 用输入框的实时值而非 settings.proxyUrl——后者要等失焦/回车才更新。
   */
  const handleTestProxy = () => {
    const input = proxyInputRef.current;
    const value = input ? input.value : settings.proxyUrl;
    setProxyUrl(value);
    setProxyTesting(true);
    setProxyTest(null);
    void testProxy(value)
      .then(setProxyTest)
      .catch(() => setProxyTest({ ok: false, reason: 'connect' }))
      .finally(() => setProxyTesting(false));
  };

  useEffect(() => {
    void getAppInfo()
      .then(setAppInfo)
      .catch(() => setAppInfo(null));
  }, []);

  // 加载 hook 安装状态
  useEffect(() => {
    void getHookStatuses()
      .then(setHookStatuses)
      .catch(() => setHookStatuses({}));
  }, []);

  const handleHookInstall = (agentId: string) => {
    setHookBusy(agentId);
    void installHook(agentId)
      .then((status) => setHookStatuses((prev) => ({ ...prev, [agentId]: status })))
      .catch(() => undefined)
      .finally(() => setHookBusy(null));
  };

  const handleHookUninstall = (agentId: string) => {
    setHookBusy(agentId);
    void uninstallHook(agentId)
      .then((status) => setHookStatuses((prev) => ({ ...prev, [agentId]: status })))
      .catch(() => undefined)
      .finally(() => setHookBusy(null));
  };

  const handleInstallAll = () => {
    setHookBusyAll(true);
    const agents = Object.keys(hookStatuses);
    void Promise.all(
      agents.map((agentId) => installHook(agentId).then((status) => ({ agentId, status }))),
    )
      .then((results) => {
        setHookStatuses((prev) => {
          const next = { ...prev };
          for (const { agentId, status } of results) next[agentId] = status;
          return next;
        });
      })
      .catch(() => undefined)
      .finally(() => setHookBusyAll(false));
  };

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSettings();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeSettings]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.filter(
      (s) =>
        t(s.labelKey).toLowerCase().includes(q) ||
        s.keywords.some((k) => k.toLowerCase().includes(q)),
    );
  }, [query, t]);

  // 搜索后若当前分类被过滤掉，自动切到第一个可见项
  useEffect(() => {
    if (filtered.length > 0 && !filtered.some((s) => s.id === active)) {
      setActive(filtered[0].id);
    }
  }, [filtered, active]);

  return (
    <div className="settings-overlay" role="presentation" onMouseDown={closeSettings}>
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 左侧导航 */}
        <nav className="settings-nav">
          <div className="settings-nav__search">
            <span className="settings-nav__search-icon" aria-hidden="true">
              <IconSearch size={14} />
            </span>
            <input
              type="search"
              className="settings-nav__search-input"
              placeholder={t('settings.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t('settings.search')}
            />
          </div>

          <div className="settings-nav__list">
            {filtered.map((s) => (
              <NavItem
                key={s.id}
                section={s}
                active={active === s.id}
                onSelect={() => setActive(s.id)}
              />
            ))}

            {filtered.length === 0 && (
              <div className="settings-nav__empty">{t('settings.noResults')}</div>
            )}
          </div>
        </nav>

        {/* 右侧内容 */}
        <div className="settings-content">
          <button
            type="button"
            className="settings-content__close"
            onClick={closeSettings}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <IconClose size={15} />
          </button>

          <div className="settings-content__scroll">
            {active === 'general' && (
              <Section title={t('settings.general')}>
                <Row label={t('settings.language')} hint={t('settings.languageHint')}>
                  <div className="segmented" role="radiogroup" aria-label={t('settings.language')}>
                    {LANGUAGES.map((lang: Language) => {
                      const isActive = settings.language === lang;
                      return (
                        <button
                          key={lang}
                          type="button"
                          role="radio"
                          aria-checked={isActive}
                          className={`segmented__item ${isActive ? 'segmented__item--active' : ''}`}
                          onClick={() => setLanguage(lang)}
                        >
                          {LANGUAGE_LABELS[lang]}
                        </button>
                      );
                    })}
                  </div>
                </Row>

                <Row label={t('settings.theme')} hint={t('settings.themeHint')}>
                  <div className="segmented" role="radiogroup" aria-label={t('settings.theme')}>
                    {THEME_OPTIONS.map((option) => {
                      const label = t(option.labelKey);
                      const isActive = settings.theme === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={isActive}
                          className={`segmented__item ${isActive ? 'segmented__item--active' : ''}`}
                          onClick={() => setTheme(option.value)}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  <span className="settings-value">
                    {t(resolvedTheme === 'dark' ? 'theme.dark' : 'theme.light')}
                  </span>
                </Row>

                <Row label={t('settings.fontSize')} hint={t('settings.fontSizeHint')}>
                  <input
                    type="range"
                    min={MIN_FONT}
                    max={MAX_FONT}
                    step={1}
                    value={settings.fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                    aria-label={t('settings.fontSize')}
                  />
                  <span className="settings-value">{settings.fontSize}px</span>
                </Row>
              </Section>
            )}

            {active === 'agents' && (
              <Section title={t('settings.agents')}>
                <div className="hooks-toolbar">
                  <button
                    type="button"
                    className="button"
                    onClick={handleInstallAll}
                    disabled={hookBusyAll || Object.keys(hookStatuses).length === 0}
                  >
                    {hookBusyAll ? '…' : t('settings.installAllHooks')}
                  </button>
                </div>

                <ul className="agent-status-list">
                  <li className="agent-list-header" role="row">
                    <span className="agent-list-header__agent" role="columnheader">
                      {t('settings.agentColumn')}
                    </span>
                    <span className="agent-list-header__hook" role="columnheader">
                      {t('settings.hookColumn')}
                    </span>
                    <span className="agent-list-header__install" role="columnheader">
                      {t('settings.installColumn')}
                    </span>
                  </li>
                  {AGENT_PRESETS.map((preset) => {
                    const isOk = isAvailable(availability, probed, preset.command);
                    const hookStatus = hookStatuses[preset.id];
                    const busy = hookBusy === preset.id;
                    const hookInstalled = hookStatus === 'installed';
                    return (
                      <li key={preset.id} className="agent-status">
                        <span className="agent-status__agent">
                          <span
                            className={`agent-status__dot ${isOk ? 'is-ok' : 'is-missing'}`}
                            aria-hidden="true"
                          />
                          <span className="agent-status__name">{preset.label}</span>
                        </span>
                        <span className="agent-status__hook">
                          {hookStatus !== undefined && isOk ? (
                            <button
                              type="button"
                              className="button button--small"
                              disabled={busy || hookStatus === 'unsupported'}
                              onClick={() =>
                                hookInstalled
                                  ? handleHookUninstall(preset.id)
                                  : handleHookInstall(preset.id)
                              }
                            >
                              {busy
                                ? '…'
                                : hookInstalled
                                  ? t('settings.uninstallHook')
                                  : t('settings.installHook')}
                            </button>
                          ) : (
                            <span className="agent-status__hook-state is-missing">—</span>
                          )}
                        </span>
                        <span className={`agent-status__install ${isOk ? 'is-ok' : 'is-missing'}`}>
                          {isOk ? t('settings.installed') : t('settings.notInstalled')}
                        </span>
                      </li>
                    );
                  })}
                </ul>

                <Row label={t('settings.resetHint')}>
                  <button
                    type="button"
                    className="button"
                    onClick={() => void refreshAgents()}
                  >
                    {t('settings.reset')}
                  </button>
                </Row>
              </Section>
            )}

            {active === 'proxy' && (
              <Section title={t('settings.proxy')}>
                <Row label={t('settings.proxyUrl')} hint={t('settings.proxyUrlHint')}>
                  {/*
                   * 非受控输入 + key：输入过程中不触发 IPC，失焦或回车才提交；
                   * 主进程归一化（去空白 / 补 http:// 前缀）回推后，key 变化
                   * 让输入框以最终值重挂载，展示真实生效的地址。
                   */}
                  <input
                    key={settings.proxyUrl}
                    ref={proxyInputRef}
                    type="text"
                    className="settings-input"
                    defaultValue={settings.proxyUrl}
                    placeholder={t('settings.proxyPlaceholder')}
                    spellCheck={false}
                    onBlur={(e) => setProxyUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                    aria-label={t('settings.proxyUrl')}
                  />
                  <button
                    type="button"
                    className="button"
                    onClick={handleTestProxy}
                    disabled={proxyTesting}
                  >
                    {proxyTesting ? t('settings.proxyTesting') : t('settings.proxyTest')}
                  </button>
                </Row>

                {proxyTest && (
                  <p
                    className={`proxy-test-result ${
                      proxyTest.ok ? 'proxy-test-result--ok' : 'proxy-test-result--fail'
                    }`}
                    role="status"
                  >
                    {describeProxyTest(proxyTest, t)}
                  </p>
                )}

                <Row label={t('settings.proxyAgents')} hint={t('settings.proxyAgentsHint')} stacked>
                  <div className="proxy-agent-list">
                    {AGENT_PRESETS.map((preset) => {
                      const enabled = settings.proxyAgents[preset.command] === true;
                      return (
                        <div key={preset.id} className="proxy-agent">
                          <span className="proxy-agent__name">{preset.label}</span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={enabled}
                            aria-label={`${preset.label} — ${t('settings.proxyAgents')}`}
                            className={`switch ${enabled ? 'switch--on' : ''}`}
                            onClick={() => setAgentProxy(preset.command, !enabled)}
                          >
                            <span className="switch__knob" aria-hidden="true" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </Row>
              </Section>
            )}

            {active === 'about' && (
              <Section title={t('settings.about')}>
                <Row label={t('settings.version')}>
                  <span className="settings-value">{appInfo?.version ?? '—'}</span>
                </Row>
                <Row label={t('settings.platform')}>
                  <span className="settings-value">{appInfo?.platform ?? '—'}</span>
                </Row>
              </Section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function NavItem({
  section,
  active,
  onSelect,
}: {
  section: Section;
  active: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className={`settings-nav__item ${active ? 'is-active' : ''}`}
      onClick={onSelect}
      aria-current={active}
    >
      <span className="settings-nav__icon" aria-hidden="true">
        <section.Icon size={15} />
      </span>
      <span className="settings-nav__label">{t(section.labelKey)}</span>
    </button>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  /*
   * 标题固定在滚动区之外，只有正文滚动。
   * 两侧留白放在滚动区**内部**的包裹层上：内边距若加在滚动容器上，
   * 滚动条会被推到内容里侧，而不是贴在窗口最右边。
   */
  return (
    <section className="settings-section">
      <h2 className="settings-section__title">{title}</h2>
      <div className="settings-section__scroll">
        <div className="settings-section__body">{children}</div>
      </div>
    </section>
  );
}

function Row({
  label,
  hint,
  stacked,
  children,
}: {
  label: string;
  hint?: string;
  /** 纵向堆叠（标签在上，控件占满整行）——用于列表类控件。 */
  stacked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`settings-row ${stacked ? 'settings-row--stacked' : ''}`}>
      <div className="settings-row__label">
        <span className="settings-row__name">{label}</span>
        {hint && <span className="settings-row__hint">{hint}</span>}
      </div>
      <div className="settings-row__control">{children}</div>
    </div>
  );
}
