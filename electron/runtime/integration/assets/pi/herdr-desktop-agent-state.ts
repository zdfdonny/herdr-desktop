// @ts-nocheck
// HERDR_INTEGRATION_ID=herdr-desktop
// HERDR_INTEGRATION_VERSION=3
const SOURCE = "herdr:pi";
const AGENT = "pi";
const REPORT_URL = process.env.HERDR_DESKTOP_REPORT_URL;
const PANE_ID = process.env.HERDR_DESKTOP_PANE_ID;

let reportSeq = Date.now() * 1000;
let currentSessionId;
let currentSessionPath;

function nextReportSeq() {
  reportSeq += 1;
  return reportSeq;
}

function absolute(file) {
  return typeof file === "string" && (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file));
}

function updateSessionRef(ctx) {
  try {
    const f = ctx?.sessionManager?.getSessionFile?.();
    currentSessionPath = absolute(f) ? f : undefined;
  } catch { currentSessionPath = undefined; }
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    currentSessionId = typeof id === "string" && id ? id : undefined;
  } catch { currentSessionId = undefined; }
}

function sessionRef() {
  const out = {};
  if (currentSessionPath) out.sessionPath = currentSessionPath;
  else if (currentSessionId) out.sessionId = currentSessionId;
  return out;
}

function withSessionRef(params) {
  return { ...params, ...sessionRef() };
}

async function report(payload) {
  if (!REPORT_URL || !PANE_ID) return true;
  try {
    const res = await fetch(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paneId: PANE_ID, source: SOURCE, agent: AGENT, ...payload }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function reportWithRetry(payload) {
  if (await report(payload)) return true;
  await new Promise((resolve) => setTimeout(resolve, 500));
  return report(payload);
}

function reportSession(sessionStartSource) {
  const ref = sessionRef();
  if (!ref.sessionPath && !ref.sessionId) return Promise.resolve(true);
  return reportWithRetry({ ...ref, sessionStartSource, seq: nextReportSeq() });
}

function sendState(state, message) {
  return reportWithRetry(withSessionRef({ state, message, seq: nextReportSeq() }));
}

let sendInFlight = false;
let queuedState;

function queueState(state, message) {
  queuedState = { state, message };
  if (!sendInFlight) void drainStateQueue();
}

async function drainStateQueue() {
  if (sendInFlight) return;
  sendInFlight = true;
  try {
    while (queuedState) {
      const next = queuedState;
      queuedState = undefined;
      await sendState(next.state, next.message);
    }
  } finally {
    sendInFlight = false;
    if (queuedState) void drainStateQueue();
  }
}

export default function (pi) {
  if (!REPORT_URL || !PANE_ID) return;

  let agentActive = false;
  let blockedCount = 0;
  let blockedMessage;
  let lastState;
  let lastMessage;
  let rootSession = false;

  function desiredState() {
    if (blockedCount > 0) return { state: "blocked", message: blockedMessage };
    if (agentActive) return { state: "working", message: undefined };
    return { state: "idle", message: undefined };
  }

  function publishState(force = false) {
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) return;
    lastState = next.state;
    lastMessage = next.message;
    queueState(next.state, next.message);
  }

  pi.events.on("herdr:blocked", (data) => {
    if (!rootSession) return;
    if (!data?.active) {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) blockedMessage = undefined;
      publishState();
      return;
    }
    blockedCount += 1;
    blockedMessage = data.label;
    publishState();
  });

  pi.on("session_start", async (_event, ctx) => {
    // TUI only：RPC/JSON/print 等 headless 模式没有可见的 PTY。
    if (ctx?.mode !== "tui") return;
    rootSession = true;
    updateSessionRef(ctx);
    await reportSession(_event?.reason);
    // 扩展被热重载后可能不再触发 agent_start，据此回填状态。
    agentActive = ctx?.isIdle?.() === false;
    publishState(true);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession) return;
    updateSessionRef(ctx);
    void reportSession();
    agentActive = true;
    publishState();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rootSession || ctx?.isIdle?.() !== true) return;
    agentActive = false;
    publishState();
  });
}
