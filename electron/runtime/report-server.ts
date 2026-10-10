/**
 * hook 上报端点 —— 官方集成 hook 把会话引用报回 Main 的本地 HTTP 服务。
 *
 * 参考 herdr 的 hook 上报通道（herdr 用 Unix socket + `HERDR_PANE_ID` 等环境变量，
 * 让 agent 的 hook 脚本把 session 引用报回 herdr server）。herdr-desktop 是
 * Electron 应用，这里用 127.0.0.1 上的随机端口 + URL token 作为等价物：
 * - token 随机生成，只在本进程存活；
 * - 只绑定回环地址，不接受外部连接；
 * - 上报内容经 router 的 `sessionRefFromReport` 再次校验官方来源。
 */

import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

export type AgentStateReport = 'working' | 'blocked' | 'idle' | 'done';

export interface SessionReport {
  paneId: string;
  source: string;
  agent: string;
  sessionId?: string | null;
  sessionPath?: string | null;
  /** agent 状态上报（对应 herdr 的 pane.report_agent state）。 */
  state?: AgentStateReport | null;
  /** 单调递增序号（对应 herdr 的 seq）。 */
  seq?: number | null;
  /** blocked 详情（对应 herdr 的 message）。 */
  message?: string | null;
  /** 会话启动来源（startup/resume/select 等，对应 herdr 的 session_start_source）。 */
  sessionStartSource?: string | null;
  /** 是否为「切换绑定后的状态重放」：true 时 Main 只刷新状态、不触发声音/toast。 */
  replay?: boolean;
  /**
   * idle 时 turn 的结束原因：`completed`（正常完成）或 `aborted`（手动停止）。
   * `aborted` 时 Main 直接把状态落到 idle、不投影 done、不触发完成声音/toast。
   */
  completion?: 'completed' | 'aborted';
}

export class ReportServer {
  private server: Server | null = null;
  private token = '';
  private port = 0;
  private handler: ((report: SessionReport) => void) | null = null;

  /** 供 hook 脚本使用的上报 URL（带 token）。 */
  get reportUrl(): string {
    if (!this.server || this.port === 0 || !this.token) return '';
    return `http://127.0.0.1:${this.port}/report?token=${this.token}`;
  }

  async start(handler: (report: SessionReport) => void): Promise<void> {
    this.handler = handler;
    this.token = randomBytes(16).toString('hex');

    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res);
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        this.server = server;
        resolve();
      });
    });
  }

  stop(): void {
    const server = this.server;
    this.server = null;
    this.token = '';
    this.port = 0;
    this.handler = null;
    if (server) {
      try {
        server.close();
      } catch {
        // 已经关闭时忽略
      }
    }
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    try {
      // 只接受 POST /report，且 token 必须匹配
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'POST' || url.pathname !== '/report') {
        res.writeHead(404).end();
        return;
      }
      if (url.searchParams.get('token') !== this.token) {
        res.writeHead(401).end();
        return;
      }

      const body = await readBody(req, 64 * 1024);
      let report: SessionReport;
      try {
        const parsed = JSON.parse(body) as Partial<SessionReport>;
        if (
          typeof parsed.paneId !== 'string' ||
          typeof parsed.source !== 'string' ||
          typeof parsed.agent !== 'string'
        ) {
          res.writeHead(400).end();
          return;
        }
        report = {
          paneId: parsed.paneId,
          source: parsed.source,
          agent: parsed.agent,
          sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
          sessionPath: typeof parsed.sessionPath === 'string' ? parsed.sessionPath : null,
          state: isState(parsed.state) ? parsed.state : null,
          seq: typeof parsed.seq === 'number' ? parsed.seq : null,
          message: typeof parsed.message === 'string' ? parsed.message : null,
          sessionStartSource: typeof parsed.sessionStartSource === 'string' ? parsed.sessionStartSource : null,
          replay: typeof parsed.replay === 'boolean' ? parsed.replay : false,
          completion:
            parsed.completion === 'completed' || parsed.completion === 'aborted'
              ? parsed.completion
              : undefined,
        };
      } catch {
        res.writeHead(400).end();
        return;
      }

      try {
        this.handler?.(report);
      } catch (error) {
        console.error('[herdr-desktop] hook report handler failed:', error);
      }
      res.writeHead(200).end('ok');
    } catch {
      res.writeHead(400).end();
    }
  }
}

function readBody(req: import('node:http').IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('report body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isState(value: unknown): value is AgentStateReport {
  return value === 'working' || value === 'blocked' || value === 'idle' || value === 'done';
}
