/**
 * DeepSeek Harness Web agent 子进程管理器。
 *
 * 与 pty-manager 的分工：
 * - pty-manager 用 node-pty（ConPTY）托管交互式终端 agent；
 * - 本模块用 child_process 托管 `dsh web`（长驻 Web 服务），并解析其
 *   stdout 打印的启动广播行作为「完全就绪」信号，返回可内嵌的认证链接。
 *
 * dsh 0.1.2-rc 起为 Web GUI 启用了浏览器认证：每次启动会打印
 *   dsh web: http://127.0.0.1:3080/?token=<令牌>
 * 浏览器打开该链接后，服务端用令牌换取签名 Cookie（HttpOnly; SameSite=Strict），
 * 之后凭 Cookie 访问，裸地址 401。Electron 的 <webview> 是顶层 guest（非 iframe），
 * 可直接加载该认证链接完成换发，因此这里无需像 iframe 方案那样再做认证代理。
 *
 * 子进程生命周期：spawn 不抛异常，失败以 WebSpawnResult 返回，由调用方转成
 * 用户可见错误（与 pty-manager 的约定一致）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolveExecutable, isWindows } from '../platform';

/** dsh 启动命令（web profile 通过子命令名解析）。 */
const DSH_COMMAND = 'dsh';
/** 等待 `dsh web:` 启动广播行的超时时间。 */
const WEB_START_TIMEOUT_MS = 60_000;
/** 启动输出缓冲上限，防止异常输出无界增长。 */
const MAX_STARTUP_BUFFER = 64 * 1024;

/** 一个 dsh web 子进程的运行时句柄。 */
export interface WebAgentRuntime {
  paneId: string;
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
      reason: 'not-found' | 'spawn-failed' | 'timeout' | 'duplicate';
      error: string;
    };

export interface WebAgentCallbacks {
  /** 已就绪的子进程意外退出。 */
  onExit: (paneId: string, exitCode: number) => void;
}

export class WebAgentManager {
  private runtimes = new Map<string, WebAgentRuntime>();
  private callbacks: WebAgentCallbacks;

  constructor(callbacks: WebAgentCallbacks) {
    this.callbacks = callbacks;
  }

  /** 该 pane 是否已有运行中的 dsh web 子进程。 */
  has(paneId: string): boolean {
    const rt = this.runtimes.get(paneId);
    return !!rt && !rt.disposed;
  }

  /**
   * 启动 dsh web 并等待就绪。
   *
   * `env` 由调用方（router）用 launchEnvFor 组装，包含平台基础环境与代理注入；
   * `cwd` 缺省为进程工作目录，通常传项目路径。
   */
  async spawn(
    paneId: string,
    env: Record<string, string>,
    cwd?: string,
  ): Promise<WebSpawnResult> {
    if (this.runtimes.has(paneId)) {
      return {
        ok: false,
        reason: 'duplicate',
        error: `pane ${paneId} already has a web agent`,
      };
    }

    const executable = resolveExecutable(DSH_COMMAND);
    if (!executable) {
      return {
        ok: false,
        reason: 'not-found',
        error: `Command not found: ${DSH_COMMAND}. Install it and make sure it is on PATH.`,
      };
    }

    const port = await findFreePort();
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
      paneId,
      child,
      port,
      url: null,
      cleanUrl: null,
      ready: false,
      disposed: false,
    };
    this.runtimes.set(paneId, runtime);

    // 永久 error 监听：防止未处理的 'error' 事件崩掉主进程。
    child.on('error', (error) => {
      console.error(`[dsh web:${paneId}] process error:`, error);
    });

    // 生命周期 exit 监听：仅在「已就绪」后转发给调用方；
    // 就绪前退出由 waitForReady 作为 spawn-failed 处理。
    child.on('exit', (code) => {
      if (runtime.disposed) return;
      runtime.disposed = true;
      this.runtimes.delete(paneId);
      if (runtime.ready) {
        this.callbacks.onExit(paneId, code ?? 1);
      }
    });

    child.stderr?.on('data', (chunk) => {
      const s = chunk.toString('utf8').trimEnd();
      if (s) console.error(`[dsh web:${paneId}]`, s);
    });

    const ready = await this.waitForReady(runtime);
    if (!ready.ok) {
      this.kill(paneId);
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

  /** 结束该 pane 的 dsh web 子进程树。 */
  kill(paneId: string): void {
    const rt = this.runtimes.get(paneId);
    if (!rt || rt.disposed) return;
    rt.disposed = true;
    this.runtimes.delete(paneId);
    killTree(rt.child);
  }

  /** 退出前结束所有子进程树。 */
  disposeAll(): void {
    for (const paneId of [...this.runtimes.keys()]) {
      this.kill(paneId);
    }
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
