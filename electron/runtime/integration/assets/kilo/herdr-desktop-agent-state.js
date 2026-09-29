// HERDR_INTEGRATION_ID=herdr-desktop
// HERDR_INTEGRATION_VERSION=3
const SOURCE = "herdr:kilo";
const AGENT = "kilo";
const REPORT_URL = process.env.HERDR_DESKTOP_REPORT_URL;
const PANE_ID = process.env.HERDR_DESKTOP_PANE_ID;

let reportSeq = Date.now() * 1000;

function nextReportSeq() {
  reportSeq += 1;
  return reportSeq;
}

function sessionIDFromProperties(properties) {
  return typeof properties?.sessionID === "string" && properties.sessionID
    ? properties.sessionID
    : undefined;
}

function stateFromSessionStatus(status) {
  if (typeof status !== "string") return undefined;
  switch (status.toLowerCase()) {
    case "idle":
      return "idle";
    case "active":
    case "busy":
    case "pending":
    case "running":
    case "streaming":
    case "working":
      return "working";
    default:
      return undefined;
  }
}

async function report(payload) {
  if (!PANE_ID || !REPORT_URL) return;
  const body = { paneId: PANE_ID, source: SOURCE, agent: AGENT, seq: nextReportSeq(), ...payload };
  try {
    await fetch(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {}
}

function reportSession(sessionID) {
  if (!sessionID) return Promise.resolve();
  return report({ sessionId: sessionID, sessionStartSource: "startup" });
}

function reportState(state, sessionID) {
  const payload = { state };
  if (sessionID) payload.sessionId = sessionID;
  return report(payload);
}

export const HerdrAgentStatePlugin = async () => {
  if (!REPORT_URL || !PANE_ID) return {};

  return {
    "chat.message": async ({ sessionID }) => {
      await reportState("working", sessionID);
    },
    event: async ({ event }) => {
      const type = event?.type;
      const properties = event?.properties ?? {};
      const sessionID = sessionIDFromProperties(properties);

      switch (type) {
        case "session.created":
        case "session.updated":
          await reportSession(sessionID);
          break;
        case "session.status": {
          const state = stateFromSessionStatus(properties.status);
          if (state) await reportState(state, sessionID);
          else await reportSession(sessionID);
          break;
        }
        case "tool.execute.before":
        case "tool.execute.after":
        case "permission.replied":
        case "question.replied":
        case "question.rejected":
        case "session.compacted":
          await reportState("working", sessionID);
          break;
        case "permission.asked":
        case "question.asked":
        case "session.error":
          await reportState("blocked", sessionID);
          break;
        case "session.idle":
          await reportState("idle", sessionID);
          break;
        case "session.deleted":
          break;
        default:
          break;
      }
    },
  };
};
