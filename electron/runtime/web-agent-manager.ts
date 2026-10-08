/**
 * DeepSeek Harness Web agent 子进程管理器。
 *
 * 与 pty-manager 的分工：
 * - pty-manager 用 node-pty（ConPTY）托管交互式终端 agent；
 * - 本模块用 child_process 托管 `dsh web`（长驻 Web 服务），并解析其
 *   stdout 打印的启动广播行作为「完全就绪」信号，返回可内嵌的认证链接。
 *
 * 进程模型（共享单进程）：
 * **全 app 只维护一个** `dsh web`
 * 进程，多个 web pane（窗口）共享它，而不是每个 pane 各起一个进程。
 * - `acquire`：确保共享进程已就绪（未就绪则启动），并登记该 pane 为使用方；
 * - `release`：解除某个 pane 的使用；共享进程**保留不回收**（关闭/重开 pane
 *   时进程与 origin 不变，localStorage 能续用）；
 * - `disposeAll`：应用退出前统一回收（before-quit 调用）。
 *
 * dsh 0.1.2-rc 起为 Web GUI 启用了浏览器认证：每次启动会打印
 *   dsh web: http://127.0.0.1:3080/?token=<令牌>
 * 该令牌在进程存活期内**可复用**（`authorizeIndex` 只做比对，不为一次性消费），
 * 因此多个 <webview>（各自独立的 partition）加载同一认证链接都能各自换发 Cookie。
 *
 * 子进程生命周期：spawn 不抛异常，失败以 WebSpawnResult 返回，由调用方转成
 * 用户可见错误（与 pty-manager 的约定一致）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolveExecutable, isWindows } from '../platform';

/** dsh 启动命令（web profile 通过子命令名解析）。 */
const DSH_COMMAND = 'dsh';
/**
 * 共享 dsh web 进程的固定监听端口。
 *
 * 固定端口 → origin（`http://127.0.0.1:PORT`）跨重启稳定 → 每个 <webview> 的
 * partition localStorage 才能续用，dsh GUI 才能恢复「最近打开的会话」。
 * 与浏览器默认的 `dsh web`（3080）区分开，避免端口冲突。
 */
const DSH_WEB_PORT = 8399;
/** 等待 `dsh web:` 启动广播行的超时时间。 */
const WEB_START_TIMEOUT_MS = 60_000;
/** 启动输出缓冲上限，防止异常输出无界增长。 */
const MAX_STARTUP_BUFFER = 64 * 1024;

/** 共享 dsh web 子进程的运行时句柄（全 app 只有一个）。 */
interface WebAgentRuntime {
  child: ChildProcess;
  port: number;
  /** 从 stdout 学到的完整 URL（可能带 token 查询参数）。 */
  url: string | null;
  /** 去掉 token 后的干净 URL。 */
  cleanUrl: string | null;
  /** 是否已收到启动广播行（完全就绪）。 */
  ready: boolean;
  disposed: boolean;
}

export type WebSpawnResult =
  | { ok: true; url: string; cleanUrl: string; port: number }
  | {
      ok: false;
      reason: 'not-found' | 'spawn-failed' | 'timeout';
      error: string;
    };

export interface WebAgentCallbacks {
  /** 已就绪的共享进程意外退出，返回所有正在使用它的 paneId。 */
  onExit: (paneIds: string[], exitCode: number) => void;
}

export class WebAgentManager {
  /** 当前共享进程（null = 尚未启动或已回收）。 */
  private shared: WebAgentRuntime | null = null;
  /** 正在使用共享进程的 pane 集合（引用计数）。 */
  private refs = new Set<string>();
  /** 进行中的首次启动（并发 acquire 复用同一次启动，避免重复 spawn）。 */
  private pendingAcquire: Promise<WebSpawnResult> | null = null;
  private callbacks: WebAgentCallbacks;

  constructor(callbacks: WebAgentCallbacks) {
    this.callbacks = callbacks;
  }

  /** 该 pane 是否正在使用共享进程。 */
  has(paneId: string): boolean {
    return this.refs.has(paneId);
  }

  /**
   * 确保共享 dsh web 进程已就绪，并登记 `paneId` 为使用方。
   *
   * - 已就绪：直接复用，登记后立即返回共享 URL；
   * - 未就绪：启动一次（`env` / `cwd` 取**首个**调用方的值），
   *   并发的后续调用复用同一次启动；
   * - 启动失败：不登记该 pane，返回失败原因。
   */
  async acquire(
    paneId: string,
    env: Record<string, string>,
    cwd?: string,
  ): Promise<WebSpawnResult> {
    if (this.shared && this.shared.ready && !this.shared.disposed) {
      this.refs.add(paneId);
      return {
        ok: true,
        url: this.shared.url as string,
        cleanUrl: this.shared.cleanUrl as string,
        port: this.shared.port,
      };
    }

    if (!this.pendingAcquire) {
      this.pendingAcquire = this.spawnShared(env, cwd).finally(() => {
        this.pendingAcquire = null;
      });
    }
    const result = await this.pendingAcquire;
    if (result.ok) {
      this.refs.add(paneId);
    } else {
      this.refs.delete(paneId);
    }
    return result;
  }

  /**
   * 解除某个 pane 的使用。
   *
   * 共享进程在关闭全部 pane 后**仍然保留**（不回收），等应用退出时再由
   * `disposeAll` 统一回收。这样关闭/重开 pane 时进程与 origin 都不变，
   * localStorage 能续用，会话恢复也更稳定。
   */
  release(paneId: string): void {
    this.refs.delete(paneId);
  }

  /** 退出前强制回收共享进程树（before-quit 调用）。 */
  disposeAll(): void {
    this.killShared();
  }

  /** 启动共享进程并等待就绪（不负责引用计数，由 acquire 统一登记）。 */
  private async spawnShared(env: Record<string, string>, cwd?: string): Promise<WebSpawnResult> {
    /*
     * 必须传入 `env.PATH`（登录 shell 解析出的那份），与 pty-manager 一致：
     * 从 Finder / Dock 启动的 macOS 应用拿不到用户真实 PATH（通常只有
     * `/usr/bin:/bin:/usr/sbin:/sbin`），homebrew 的 `/opt/homebrew/bin` 和
     * npm global 都不在其中，否则会出现「列表显示已安装、点进去却报
     * Command not found」的自相矛盾结果。
     */
    const executable = resolveExecutable(DSH_COMMAND, env.PATH ?? env.Path ?? '');
    if (!executable) {
      return {
        ok: false,
        reason: 'not-found',
        error: `Command not found: ${DSH_COMMAND}. Install it and make sure it is on PATH.`,
      };
    }

    const port = await pickPort(DSH_WEB_PORT);
    if (port === 0) {
      return {
        ok: false,
        reason: 'spawn-failed',
        error: 'Could not allocate a local port for the web agent',
      };
    }

    /*
     * Windows：dsh 是 npm 生成的 .cmd 垫片，Node ≥18.20 无 shell 执行 .cmd
     * 会抛 EINVAL（CVE-2024-27980 防护），必须经 shell 命中；含空格路径加引号。
     * POSIX：dsh 是带 shebang 的 shell 脚本，直接 exec 即可。
     */
    const useShell = isWindows;
    const file =
      isWindows && /[\s"]/.test(executable) ? `"${executable}"` : executable;
    const args = ['web', '--no-open', '--host', '127.0.0.1', '--port', String(port)];

    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: cwd ?? process.cwd(),
        env,
        shell: useShell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return {
        ok: false,
        reason: 'spawn-failed',
        error: `Failed to start ${DSH_COMMAND}: ${describeError(error)}`,
      };
    }

    const runtime: WebAgentRuntime = {
      child,
      port,
      url: null,
      cleanUrl: null,
      ready: false,
      disposed: false,
    };
    this.shared = runtime;

    // 永久 error 监听：防止未处理的 'error' 事件崩掉主进程。
    child.on('error', (error) => {
      console.error('[dsh web] process error:', error);
    });

    // 生命周期 exit 监听：仅在「已就绪」后转发给调用方；
    // 就绪前退出由 waitForReady 作为 spawn-failed 处理。
    child.on('exit', (code) => {
      if (runtime.disposed) return;
      runtime.disposed = true;
      if (this.shared === runtime) this.shared = null;
      const paneIds = [...this.refs];
      this.refs.clear();
      if (runtime.ready) {
        this.callbacks.onExit(paneIds, code ?? 1);
      }
    });

    child.stderr?.on('data', (chunk) => {
      const s = chunk.toString('utf8').trimEnd();
      if (s) console.error('[dsh web]', s);
    });

    const ready = await this.waitForReady(runtime);
    if (!ready.ok) {
      this.killShared();
      return ready;
    }

    runtime.url = ready.url;
    runtime.cleanUrl = ready.cleanUrl;
    runtime.ready = true;
    // 就绪后不再解析 stdout，保持流流动避免子进程写阻塞。
    child.stdout?.resume();
    return { ok: true, url: ready.url, cleanUrl: ready.cleanUrl, port };
  }

  /** 等待 `dsh web: <url>` 启动广播行（完全就绪信号）。 */
  private waitForReady(
    runtime: WebAgentRuntime,
  ): Promise<
    | { ok: true; url: string; cleanUrl: string }
    | { ok: false; reason: 'spawn-failed' | 'timeout'; error: string }
  > {
    return new Promise((resolve) => {
      const { child } = runtime;
      let buf = '';
      let settled = false;

      const finish = (
        value:
          | { ok: true; url: string; cleanUrl: string }
          | { ok: false; reason: 'spawn-failed' | 'timeout'; error: string },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(value);
      };

      const timer = setTimeout(() => {
        finish({
          ok: false,
          reason: 'timeout',
          error: 'Timed out waiting for dsh web to start',
        });
      }, WEB_START_TIMEOUT_MS);

      const onData = (chunk: Buffer) => {
        buf = (buf + chunk.toString('utf8')).slice(-MAX_STARTUP_BUFFER);
        const url = extractWebUrl(buf);
        if (url) {
          finish({ ok: true, url, cleanUrl: stripToken(url) });
        }
      };

      const onExit = (code: number | null) => {
        finish({
          ok: false,
          reason: 'spawn-failed',
          error: `dsh web exited before ready (code ${code ?? 'null'})`,
        });
      };

      const onError = (error: Error) => {
        finish({ ok: false, reason: 'spawn-failed', error: describeError(error) });
      };

      const cleanup = () => {
        child.stdout?.off('data', onData);
        child.off('exit', onExit);
        child.off('error', onError);
      };

      child.stdout?.on('data', onData);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  }

  /** 回收共享进程树并清空引用。 */
  private killShared(): void {
    const rt = this.shared;
    this.shared = null;
    this.refs.clear();
    if (!rt || rt.disposed) return;
    rt.disposed = true;
    killTree(rt.child);
  }
}

/** 从启动输出中提取 `dsh web: <url>` 广播行里的 URL。 */
function extractWebUrl(text: string): string | null {
  const match = text.match(/dsh web:\s*(\S+)/);
  return match ? match[1] : null;
}

/** 去掉 URL 的查询与哈希，得到干净地址。 */
function stripToken(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/** 分配一个本机回环空闲端口。 */
function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(0));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** 探测指定端口是否空闲（能 bind 即视为空闲）。 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * 选择监听端口：优先用固定的共享端口（保持 origin 稳定，localStorage 才能续用
 * 「最近会话」）；被占用时回退到任意空闲端口。
 */
async function pickPort(preferredPort?: number): Promise<number> {
  if (
    typeof preferredPort === 'number' &&
    Number.isInteger(preferredPort) &&
    preferredPort > 0 &&
    preferredPort <= 65535
  ) {
    if (await isPortFree(preferredPort)) return preferredPort;
  }
  return findFreePort();
}

/**
 * 结束进程树。
 *
 * Windows 上 spawn 走 shell 时，child 是 cmd.exe，kill 只能杀 cmd，
 * 需 taskkill /t 连真正的 node 进程一起结束。
 */
function killTree(child: ChildProcess): void {
  if (child.pid == null) return;
  if (isWindows) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      // 进程可能已退出
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
