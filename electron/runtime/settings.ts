/**
 * 应用设置管理 —— 主题偏好、语言、字号、侧栏状态，持久化到 userData。
 *
 * 主题模型：支持 system / light / dark 三态，
 * system 表示跟随操作系统外观。语言默认中文。
 */

import { app } from 'electron';
import { promises as fs, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSettings, ThemePreference, Language } from '../../shared/state';

const FILENAME = 'settings.json';

const DEFAULTS: AppSettings = {
  theme: 'system',
  language: 'zh-CN',
  fontSize: 13,
  sidebarCollapsed: false,
  proxyUrl: '',
  proxyAgents: {},
};

function settingsPath(): string {
  return join(app.getPath('userData'), FILENAME);
}

export class SettingsStore {
  private settings: AppSettings = { ...DEFAULTS };

  /** 同步加载（app ready 后调用，供首帧渲染前使用）。 */
  loadSync(): AppSettings {
    try {
      const raw = readFileSync(settingsPath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      this.settings = {
        theme: normalizeTheme(parsed.theme),
        language: normalizeLanguage(parsed.language),
        fontSize: typeof parsed.fontSize === 'number' ? parsed.fontSize : DEFAULTS.fontSize,
        sidebarCollapsed: parsed.sidebarCollapsed === true,
        proxyUrl: normalizeProxyUrl(parsed.proxyUrl),
        proxyAgents: normalizeProxyAgents(parsed.proxyAgents),
      };
    } catch {
      this.settings = { ...DEFAULTS };
    }
    return this.settings;
  }

  get(): AppSettings {
    return { ...this.settings };
  }

  async setTheme(theme: ThemePreference): Promise<AppSettings> {
    this.settings.theme = normalizeTheme(theme);
    await this.save();
    return this.get();
  }

  async setLanguage(language: Language): Promise<AppSettings> {
    this.settings.language = normalizeLanguage(language);
    await this.save();
    return this.get();
  }

  async setFontSize(fontSize: number): Promise<AppSettings> {
    if (Number.isFinite(fontSize)) {
      this.settings.fontSize = Math.min(24, Math.max(9, Math.round(fontSize)));
    }
    await this.save();
    return this.get();
  }

  async setSidebarCollapsed(collapsed: boolean): Promise<AppSettings> {
    this.settings.sidebarCollapsed = collapsed === true;
    await this.save();
    return this.get();
  }

  async setProxyUrl(url: string): Promise<AppSettings> {
    this.settings.proxyUrl = normalizeProxyUrl(url);
    await this.save();
    return this.get();
  }

  async setAgentProxy(command: string, enabled: boolean): Promise<AppSettings> {
    const key = command.trim();
    if (key) {
      if (enabled) {
        this.settings.proxyAgents = { ...this.settings.proxyAgents, [key]: true };
      } else {
        const next = { ...this.settings.proxyAgents };
        delete next[key];
        this.settings.proxyAgents = next;
      }
    }
    await this.save();
    return this.get();
  }

  private async save(): Promise<void> {
    const file = settingsPath();
    const tmp = `${file}.tmp`;
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(this.settings, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }
}

function normalizeTheme(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

function normalizeLanguage(value: unknown): Language {
  return value === 'en' || value === 'zh-CN' ? value : 'zh-CN';
}

/**
 * 代理地址归一化：去空白；非空且缺少协议时补 http:// 前缀。
 *
 * 大多数读取 HTTP_PROXY 的库要求可解析的 URL（如 Node undici），
 * 裸的 host:port 会被当作无效值忽略，因此这里统一补全。
 */
function normalizeProxyUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  if (!url) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) return url;
  return `http://${url}`;
}

/** proxyAgents 归一化：只保留值为 true 的键（缺省即视为关闭）。 */
function normalizeProxyAgents(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (key && enabled === true) {
      result[key] = true;
    }
  }
  return result;
}
