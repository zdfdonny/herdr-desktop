// HERDR_INTEGRATION_ID=herdr-desktop
// HERDR_INTEGRATION_VERSION=2
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
