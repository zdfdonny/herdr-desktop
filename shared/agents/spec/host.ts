/**
 * 宿主环境与路径工具。
 *
 * `HostEnv` 是**注入**的，而不是在 descriptor 里直接读 `process.env` / `homedir()`：
 * - `shared/` 保持零 Node 依赖（主进程与渲染进程都能 import）；
 * - 测试可以构造任意平台/家目录，对 Windows 与 POSIX 路径规则都能断言。
 */

/** 描述"当前跑在什么机器上"的最小环境。 */
export interface HostEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

/** 路径分隔符（按宿主平台）。 */
export function pathSeparator(host: HostEnv): string {
  return host.platform === 'win32' ? '\\' : '/';
}

/**
 * 拼接路径（等价于 `node:path` 的 `join`，只覆盖本项目用到的形态）。
 *
 * 之所以自己实现：descriptor 在 `shared/` 里声明配置目录，不能引用 `node:path`。
 * 覆盖范围：绝对路径（POSIX `/x`、Windows `C:\x`、UNC `\\server\share`）+ 相对片段。
 */
export function joinPath(host: HostEnv, ...segments: string[]): string {
  const sep = pathSeparator(host);
  const raw = segments.filter((s) => s.length > 0);
  if (raw.length === 0) return '';

  const pieces: string[] = [];
  for (const segment of raw) {
    for (const piece of segment.split(/[\\/]+/)) {
      if (piece.length > 0 && piece !== '.') pieces.push(piece);
    }
  }

  const head = raw[0];
  let prefix = '';
  if (host.platform === 'win32') {
    if (/^[A-Za-z]:/.test(head)) {
      // 盘符已在 pieces[0] 里，交给 join 自然还原。
    } else if (head.startsWith('\\\\') || head.startsWith('//')) {
      prefix = sep + sep; // UNC
    } else if (head.startsWith('\\') || head.startsWith('/')) {
      prefix = sep;
    }
  } else if (head.startsWith('/')) {
    prefix = '/';
  }

  return prefix + pieces.join(sep);
}

/** 展开 `~` / `~/` / `~\` 前缀（对应重构前的 expandTilde）。 */
export function expandTilde(host: HostEnv, path: string): string {
  if (path === '~') return host.home;
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return joinPath(host, host.home, path.slice(2));
  }
  return path;
}

/**
 * 环境变量覆盖 → 家目录回退（对应重构前的 `envOrHome`）。
 *
 * 环境变量存在但为空白时视为未设置。
 */
export function envOrHome(
  host: HostEnv,
  envVar: string,
  fallbackSegments: readonly string[],
): string {
  const env = host.env[envVar];
  if (env && env.trim()) return expandTilde(host, env.trim());
  return joinPath(host, host.home, ...fallbackSegments);
}
