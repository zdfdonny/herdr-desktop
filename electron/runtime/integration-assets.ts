/**
 * 非 hook 集成的资产（pi/omp 扩展、opencode/kilo 插件、hermes 插件）。
 *
 * 这些资产是写入 agent 配置目录的独立脚本，参考 herdr `src/integration/assets/`
 * 的对应实现，但上报通道从 herdr 的 Unix socket / CLI 换成 herdr-desktop 的
 * 本地 HTTP 上报端点（`HERDR_DESKTOP_REPORT_URL`）。只上报会话引用与状态，
 * 不实现 herdr 完整的重试/队列/冲突逻辑（终端检测仍兜底状态）。
 */

export const PI_ASSET = `// HERDR_INTEGRATION_ID=herdr-desktop
// HERDR_INTEGRATION_VERSION=1
// @ts-nocheck
const SOURCE = "herdr:pi";
const AGENT = "pi";
const REPORT_URL = process.env.HERDR_DESKTOP_REPORT_URL;
const PANE_ID = process.env.HERDR_DESKTOP_PANE_ID;

async function report(payload) {
  if (!REPORT_URL || !PANE_ID) return;
  try {
    await fetch(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paneId: PANE_ID, source: SOURCE, agent: AGENT, ...payload }),
    });
  } catch {}
}

let sessionId;
let sessionPath;

function absolute(file) {
  return typeof file === "string" && (file.startsWith("/") || /^[A-Za-z]:[\\\\/]/.test(file));
}

function updateSessionRef(ctx) {
  try {
    const f = ctx?.sessionManager?.getSessionFile?.();
    sessionPath = absolute(f) ? f : undefined;
  } catch { sessionPath = undefined; }
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    sessionId = typeof id === "string" && id ? id : undefined;
  } catch { sessionId = undefined; }
}

function sessionRef() {
  const out = {};
  if (sessionPath) out.sessionPath = sessionPath;
  if (sessionId) out.sessionId = sessionId;
  return out;
}

export default function (pi) {
  if (!REPORT_URL || !PANE_ID) return;

  pi.on("session_start", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
    updateSessionRef(ctx);
    report({ ...sessionRef() });
  });

  pi.on("agent_start", (_event, ctx) => {
    updateSessionRef(ctx);
    report({ ...sessionRef(), state: "working" });
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx?.isIdle?.() === true) report({ ...sessionRef(), state: "idle" });
  });

  pi.events?.on?.("herdr:blocked", (data) => {
    report({ ...sessionRef(), state: data?.active ? "blocked" : "idle" });
  });
}
`;

export const OMP_ASSET = `// HERDR_INTEGRATION_ID=herdr-desktop
// HERDR_INTEGRATION_VERSION=1
// @ts-nocheck
const SOURCE = "herdr:omp";
const AGENT = "omp";
const REPORT_URL = process.env.HERDR_DESKTOP_REPORT_URL;
const PANE_ID = process.env.HERDR_DESKTOP_PANE_ID;
const NESTED = process.env.OMPCODE === "1";

async function report(payload) {
  if (!REPORT_URL || !PANE_ID || NESTED) return;
  try {
    await fetch(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paneId: PANE_ID, source: SOURCE, agent: AGENT, ...payload }),
    });
  } catch {}
}

let sessionId;
let sessionPath;

function absolute(file) {
  return typeof file === "string" && (file.startsWith("/") || /^[A-Za-z]:[\\\\/]/.test(file));
}

function updateSessionRef(ctx) {
  try {
    const f = ctx?.sessionManager?.getSessionFile?.();
    sessionPath = absolute(f) ? f : undefined;
  } catch { sessionPath = undefined; }
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    sessionId = typeof id === "string" && id ? id : undefined;
  } catch { sessionId = undefined; }
}

function sessionRef() {
  const out = {};
  if (sessionPath) out.sessionPath = sessionPath;
  if (sessionId) out.sessionId = sessionId;
  return out;
}

export default function (pi) {
  if (!REPORT_URL || !PANE_ID || NESTED) return;

  pi.on("session_start", (_event, ctx) => {
    updateSessionRef(ctx);
    report({ ...sessionRef() });
  });

  pi.on("session_switch", (_event, ctx) => {
    updateSessionRef(ctx);
    report({ ...sessionRef() });
  });

  pi.on("agent_start", (_event, ctx) => {
    updateSessionRef(ctx);
    report({ ...sessionRef(), state: "working" });
  });

  pi.on("agent_end", () => {
    report({ ...sessionRef(), state: "idle" });
  });

  pi.on("tool_approval_requested", (_event, ctx) => {
    updateSessionRef(ctx);
    report({ ...sessionRef(), state: "blocked" });
  });

  pi.on("tool_approval_resolved", () => {
    report({ ...sessionRef(), state: "working" });
  });
}
`;

export const OPENCODE_ASSET = `// HERDR_INTEGRATION_ID=herdr-desktop
// HERDR_INTEGRATION_VERSION=1
const SOURCE = "herdr:opencode";
const AGENT = "opencode";
const REPORT_URL = process.env.HERDR_DESKTOP_REPORT_URL;
const PANE_ID = process.env.HERDR_DESKTOP_PANE_ID;

async function report(payload) {
  if (!REPORT_URL || !PANE_ID) return;
  try {
    await fetch(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paneId: PANE_ID, source: SOURCE, agent: AGENT, ...payload }),
    });
  } catch {}
}

function sessionIDFrom(properties) {
  return typeof properties?.sessionID === "string" && properties.sessionID
    ? properties.sessionID
    : undefined;
}

export const HerdrAgentStatePlugin = async () => {
  if (!REPORT_URL || !PANE_ID) return {};
  return {
    event: async ({ event }) => {
      const type = event?.type;
      const sessionID = sessionIDFrom(event?.properties ?? {});
      switch (type) {
        case "session.created":
        case "session.updated":
          if (sessionID) await report({ sessionId: sessionID });
          break;
        case "session.status": {
          const status = event?.properties?.status;
          const kind = typeof status === "string" ? status : status?.type;
          if (typeof kind === "string") {
            const lower = kind.toLowerCase();
            if (["active", "busy", "pending", "running", "streaming", "working"].includes(lower)) {
              await report({ sessionId: sessionID, state: "working" });
            } else if (lower === "idle") {
              await report({ sessionId: sessionID, state: "idle" });
            } else if (sessionID) {
              await report({ sessionId: sessionID });
            }
          }
          break;
        }
        case "permission.asked":
        case "question.asked":
        case "session.error":
          await report({ sessionId: sessionID, state: "blocked" });
          break;
        case "session.idle":
          await report({ sessionId: sessionID, state: "idle" });
          break;
        default:
          break;
      }
    },
  };
};

export default {
  id: "herdr.opencode",
  server: HerdrAgentStatePlugin,
  setup() {},
};
`;

export const KILO_ASSET = `// HERDR_INTEGRATION_ID=herdr-desktop
// HERDR_INTEGRATION_VERSION=1
const SOURCE = "herdr:kilo";
const AGENT = "kilo";
const REPORT_URL = process.env.HERDR_DESKTOP_REPORT_URL;
const PANE_ID = process.env.HERDR_DESKTOP_PANE_ID;

async function report(payload) {
  if (!REPORT_URL || !PANE_ID) return;
  try {
    await fetch(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paneId: PANE_ID, source: SOURCE, agent: AGENT, ...payload }),
    });
  } catch {}
}

function sessionIDFrom(properties) {
  return typeof properties?.sessionID === "string" && properties.sessionID
    ? properties.sessionID
    : undefined;
}

export const HerdrAgentStatePlugin = async () => {
  if (!REPORT_URL || !PANE_ID) return {};
  return {
    event: async ({ event }) => {
      const type = event?.type;
      const sessionID = sessionIDFrom(event?.properties ?? {});
      switch (type) {
        case "session.created":
        case "session.updated":
          if (sessionID) await report({ sessionId: sessionID });
          break;
        case "permission.asked":
        case "question.asked":
        case "session.error":
          await report({ sessionId: sessionID, state: "blocked" });
          break;
        case "session.idle":
          await report({ sessionId: sessionID, state: "idle" });
          break;
        case "tool.execute.before":
        case "tool.execute.after":
          await report({ sessionId: sessionID, state: "working" });
          break;
        default:
          break;
      }
    },
  };
};
`;

export const HERMES_PLUGIN_YAML = `name: herdr-agent-state
version: "1.0"
description: Report Hermes Agent session identity to Herdr
`;

export const HERMES_PLUGIN_INIT = `"""Hermes plugin installed by herdr-desktop to report session identity."""

# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=1

from __future__ import annotations

import json
import os
import urllib.request

_SOURCE = "herdr:hermes"
_AGENT = "hermes"


def _report(payload):
    url = os.environ.get("HERDR_DESKTOP_REPORT_URL")
    pane_id = os.environ.get("HERDR_DESKTOP_PANE_ID")
    if not url or not pane_id:
        return
    body = json.dumps({"paneId": pane_id, "source": _SOURCE, "agent": _AGENT, **payload}).encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        urllib.request.urlopen(req, timeout=1)
    except Exception:
        pass


def _report_session(**kwargs):
    if kwargs.get("platform") not in {"cli", "tui", "desktop", "acp"}:
        return
    session_id = kwargs.get("session_id")
    if isinstance(session_id, str) and session_id:
        _report({"sessionId": session_id})


def _on_session_start(**kwargs):
    _report_session(**kwargs)


def _on_llm_call(**kwargs):
    if kwargs.get("platform") in {"cli", "tui", "desktop", "acp"}:
        _report({"state": "working"})


def register(ctx):
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("pre_llm_call", _on_llm_call)
`;

/**
 * DeepSeek Harness 状态上报插件的文件名（含 .mjs 后缀，确保按 ESM 加载，
 * 与 profile 的 package.json 是否声明 "type": "module" 无关）。
 *
 * 命名与其他智能体保持一致：pi/opencode/kilo/hermes 的资产都叫
 * `herdr-desktop-agent-state.*`，这里沿用同一前缀。
 */
export const DSH_STATUS_PLUGIN_NAME = 'herdr-desktop-agent-state.mjs';

/**
 * DeepSeek Harness 插件（对应其他智能体的 hook/插件资产）。
 *
 * 共享单进程模型下，一个 `dsh web` 进程服务多个 web pane。插件做两件事：
 * 1. 把 Herdr 传入的项目目录（`HERDR_DESKTOP_CWD`，回退 `process.cwd()`）以及
 *    见到的会话 cwd 注册为 DSH 工作区（`workspaceRegistry.create`，幂等）；
 * 2. 在项目工作区里新建一个空白会话，让该项目成为「最近」的工作区，内嵌 GUI
 *    启动/恢复时就会落到这个项目（打开最近会话，或复用这个空白会话）。
 *
 * 未设置 `HERDR_DESKTOP_REPORT_URL`（非 Herdr 启动）时为 no-op，不影响其它 profile。
 */
export const DSH_STATUS_PLUGIN = `// HERDR_INTEGRATION_ID=herdr-desktop
// HERDR_INTEGRATION_VERSION=1
// Self-contained DeepSeek Harness plugin: registers the Herdr project directory
// (HERDR_DESKTOP_CWD, fallback process.cwd()) as a DSH workspace and creates a
// blank session there, so the GUI opens this project instead of another one.

export const name = 'herdr-desktop-agent-state'

const REPORT_URL = process.env.HERDR_DESKTOP_REPORT_URL
const CWD = process.env.HERDR_DESKTOP_CWD || ''

export function apply(ctx) {
  // Only active when herdr-desktop launched this dsh web process.
  if (!REPORT_URL) return

  // Services resolved once via ctx.inject.
  let workspaceRegistry = null
  let sessionController = null

  const registerWorkspace = function (cwd) {
    if (!cwd || !workspaceRegistry || typeof workspaceRegistry.create !== 'function') return
    void workspaceRegistry.create(cwd).catch(function () {})
  }

  ctx.on('session/created', function (session) {
    const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : null
    registerWorkspace(cwd)
  }, { global: true })

  // EARLY: register the project workspace as soon as workspaceRegistry is ready
  // (before the web server / GUI connect), so the GUI never sees an empty list.
  ctx.inject(['workspaceRegistry'], function (c) {
    try {
      workspaceRegistry = c && (c.workspaceRegistry || (typeof c.get === 'function' ? c.get('workspaceRegistry') : null))
    } catch (error) {}
    registerWorkspace(CWD || process.cwd())
  })

  // LATE: once sessionController is ready, create a blank session so the project
  // becomes the "most recent" workspace and the GUI lands on it.
  ctx.inject(['sessionController'], function (c) {
    try {
      sessionController = c && (c.sessionController || (typeof c.get === 'function' ? c.get('sessionController') : null))
    } catch (error) {}
    void (async function () {
      const cwd = CWD || process.cwd()
      if (!workspaceRegistry || typeof workspaceRegistry.create !== 'function') return
      let ws
      try {
        ws = await workspaceRegistry.create(cwd)
      } catch (error) {
        return
      }
      if (!ws || !ws.id || !sessionController || typeof sessionController.create !== 'function') return
      try {
        await sessionController.create({ workspaceId: ws.id })
      } catch (error) {
        // Non-fatal: the GUI still creates/reuses a session on its own.
      }
    })().catch(function () {})
  })
}
`;
