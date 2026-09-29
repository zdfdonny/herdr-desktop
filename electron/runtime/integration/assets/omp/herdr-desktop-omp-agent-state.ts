// @ts-nocheck
// HERDR_INTEGRATION_ID=herdr-desktop
// HERDR_INTEGRATION_VERSION=2
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
  return typeof file === "string" && (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file));
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
