// @ts-nocheck
// HERDR_INTEGRATION_ID=herdr-desktop
// HERDR_INTEGRATION_VERSION=4
const SOURCE = "herdr:omp";
const AGENT = "omp";
const REPORT_URL = process.env.HERDR_DESKTOP_REPORT_URL;
const PANE_ID = process.env.HERDR_DESKTOP_PANE_ID;
// OMP 给它 spawn 的每个 shell 标记 OMPCODE=1：从父会话 shell 里嵌套启动的 omp
// 不是 pane 的根 agent，不能把它的短命会话盖在父会话上。
const NESTED = process.env.OMPCODE === "1";

function enabled() {
  return !!REPORT_URL && !!PANE_ID && !NESTED;
}

let requestQueue = Promise.resolve();

async function reportOnce(payload) {
  if (!enabled()) return true;
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
  if (await reportOnce(payload)) return;
  await new Promise((resolve) => setTimeout(resolve, 500));
  await reportOnce(payload);
}

function sendRequest(payload) {
  requestQueue = requestQueue.then(
    () => reportWithRetry(payload),
    () => reportWithRetry(payload),
  );
  return requestQueue;
}

const idleDebounceMs = parseDurationEnv("HERDR_DESKTOP_OMP_IDLE_DEBOUNCE_MS", 250);
const retryGraceMs = parseDurationEnv("HERDR_DESKTOP_OMP_RETRY_GRACE_MS", 2500);
const retryableErrorPattern =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

let reportSeq = Date.now() * 1000;
let currentSessionId;
let currentSessionPath;

function nextReportSeq() {
  reportSeq += 1;
  return reportSeq;
}

function isAbsoluteSessionPath(file) {
  return typeof file === "string" && (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file));
}

function updateSessionRef(ctx) {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    currentSessionPath = isAbsoluteSessionPath(file) ? file : undefined;
  } catch { currentSessionPath = undefined; }
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    currentSessionId = typeof id === "string" && id ? id : undefined;
  } catch { currentSessionId = undefined; }
}

function withSessionRef(params) {
  if (currentSessionPath) return { ...params, sessionPath: currentSessionPath };
  if (currentSessionId) return { ...params, sessionId: currentSessionId };
  return params;
}

function currentSessionRef() {
  if (currentSessionPath) return { sessionPath: currentSessionPath };
  if (currentSessionId) return { sessionId: currentSessionId };
  return undefined;
}

function parseDurationEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function reportSession(sessionStartSource = "startup") {
  const ref = currentSessionRef();
  if (!ref) return Promise.resolve();
  return sendRequest({ ...ref, sessionStartSource, seq: nextReportSeq() });
}

function sendState(state, message, seq = nextReportSeq()) {
  return sendRequest(withSessionRef({ state, message, seq }));
}

let sendInFlight = false;
let queuedState;

function queueState(state, message) {
  queuedState = { state, message, seq: nextReportSeq() };
  if (!sendInFlight) void drainStateQueue();
}

async function drainStateQueue() {
  if (sendInFlight) return;
  sendInFlight = true;
  try {
    while (queuedState) {
      const next = queuedState;
      queuedState = undefined;
      await sendState(next.state, next.message, next.seq);
    }
  } finally {
    sendInFlight = false;
    if (queuedState) void drainStateQueue();
  }
}

function lastAssistantMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function retryableErrorMessage(event) {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const assistant = lastAssistantMessage(messages);
  if (assistant?.stopReason !== "error") return undefined;
  const errorMessage = String(assistant.errorMessage ?? "");
  if (!retryableErrorPattern.test(errorMessage)) return undefined;
  return errorMessage || "retryable provider error";
}

function askBlockedMessage(args) {
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  const first = questions.find((question) => typeof question?.question === "string");
  return first?.question ? first.question : "waiting for user input";
}

export default function (pi) {
  if (!enabled()) return;

  let agentActive = false;
  let retryHoldActive = false;
  let failureBlocked = false;
  let failureMessage;
  let blockedCount = 0;
  let blockedMessage;
  let lastState;
  let lastMessage;
  let idleTimer;
  let retryTimer;
  let rootSession = false;

  function clearTimer(timer) {
    if (timer) clearTimeout(timer);
  }

  function clearPendingTimers() {
    clearTimer(idleTimer);
    clearTimer(retryTimer);
    idleTimer = undefined;
    retryTimer = undefined;
  }

  function clearFailureState() {
    retryHoldActive = false;
    failureBlocked = false;
    failureMessage = undefined;
  }

  function desiredState() {
    if (blockedCount > 0) return { state: "blocked", message: blockedMessage };
    if (failureBlocked) return { state: "blocked", message: failureMessage };
    if (agentActive || retryHoldActive) return { state: "working", message: undefined };
    return { state: "idle", message: undefined };
  }

  function publishState(force = false) {
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) return;
    lastState = next.state;
    lastMessage = next.message;
    queueState(next.state, next.message);
  }

  function scheduleIdle() {
    clearPendingTimers();
    clearFailureState();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      publishState();
    }, idleDebounceMs);
    idleTimer.unref?.();
  }

  function holdForRetry(message) {
    clearPendingTimers();
    retryHoldActive = true;
    failureBlocked = false;
    failureMessage = message;
    publishState();
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      retryHoldActive = false;
      failureBlocked = true;
      publishState();
    }, retryGraceMs);
    retryTimer.unref?.();
  }

  function activateRootSession(ctx, sessionStartSource = "startup") {
    if (ctx?.hasUI !== true) return false;
    rootSession = true;
    updateSessionRef(ctx);
    void reportSession(sessionStartSource);
    return true;
  }

  function resetSessionState() {
    clearPendingTimers();
    clearFailureState();
    agentActive = false;
    blockedCount = 0;
    blockedMessage = undefined;
  }

  function activateBlocked(message) {
    clearPendingTimers();
    blockedCount += 1;
    blockedMessage = message;
    publishState();
  }

  function deactivateBlocked() {
    blockedCount = Math.max(0, blockedCount - 1);
    if (blockedCount === 0) blockedMessage = undefined;
    publishState();
  }

  pi.events.on("herdr:blocked", (data) => {
    if (!rootSession) return;
    if (!data?.active) {
      deactivateBlocked();
      return;
    }
    activateBlocked(data.label);
  });

  pi.on("session_start", (_event, ctx) => {
    if (!activateRootSession(ctx)) return;
    // 扩展被热重载后可能不再触发 agent_start，据此回填状态。
    agentActive = ctx?.isIdle?.() === false;
    publishState(true);
  });

  pi.on("session_switch", (event, ctx) => {
    if (!activateRootSession(ctx, event?.reason || "resume")) return;
    resetSessionState();
    publishState(true);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession && !activateRootSession(ctx)) return;
    updateSessionRef(ctx);
    void reportSession();
    clearPendingTimers();
    clearFailureState();
    agentActive = true;
    publishState();
  });

  pi.on("tool_approval_requested", (event, ctx) => {
    if (!rootSession && !activateRootSession(ctx)) return;
    const label = event?.reason || `${event?.toolName || "Tool"} approval`;
    activateBlocked(label);
  });

  pi.on("tool_approval_resolved", (_event, ctx) => {
    if (!rootSession && !activateRootSession(ctx)) return;
    deactivateBlocked();
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (event?.toolName !== "ask") return;
    if (!rootSession && !activateRootSession(ctx)) return;
    activateBlocked(askBlockedMessage(event.args));
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event?.toolName !== "ask") return;
    if (!rootSession && !activateRootSession(ctx)) return;
    deactivateBlocked();
  });

  pi.on("agent_end", (event) => {
    if (!rootSession) return;
    if (!agentActive) {
      // OMP 在自动重试保持 working 时可能重复/迟到发 end，不能让这种 end 取消重试保持并误报 idle。
      return;
    }
    if (event?.willContinue === true) {
      // 已安排续跑，本次 end 不是 settle；旧版本缺该字段则走下面的原逻辑。
      return;
    }
    agentActive = false;

    const retryableMessage = retryableErrorMessage(event);
    if (retryableMessage) {
      holdForRetry(retryableMessage);
      return;
    }
    scheduleIdle();
  });

  pi.on("session_shutdown", () => {
    if (rootSession) clearPendingTimers();
  });
}
