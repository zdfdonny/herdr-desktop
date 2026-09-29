// HERDR_INTEGRATION_ID=herdr-desktop
// HERDR_INTEGRATION_VERSION=3
const SOURCE = "herdr:opencode";
const AGENT = "opencode";
const REPORT_URL = process.env.HERDR_DESKTOP_REPORT_URL;
const PANE_ID = process.env.HERDR_DESKTOP_PANE_ID;

let reportSeq = Date.now() * 1000;
let requestChain = Promise.resolve();
let reportedRootSessionID;

// 追踪子会话，避免子会话事件覆盖 pane 的根会话。
const childSessions = new Map();
const CHILD_EVENT_STATES = new Map([
  ["permission.asked", "blocked"],
  ["question.asked", "blocked"],
  ["permission.replied", "working"],
  ["question.replied", "working"],
  ["question.rejected", "working"],
]);

function nextReportSeq() {
  reportSeq += 1;
  return reportSeq;
}

function sessionIDFromProperties(properties) {
  return typeof properties?.sessionID === "string" && properties.sessionID
    ? properties.sessionID
    : undefined;
}

const SESSION_STATE_BY_STATUS = new Map([
  ["idle", "idle"],
  ["active", "working"],
  ["busy", "working"],
  ["pending", "working"],
  ["retry", "working"],
  ["running", "working"],
  ["streaming", "working"],
  ["working", "working"],
]);

function stateFromSessionStatus(status) {
  const kind = typeof status === "string" ? status : status?.type;
  return typeof kind === "string" ? SESSION_STATE_BY_STATUS.get(kind.toLowerCase()) : undefined;
}

function request(params) {
  const pending = requestChain.then(() => requestOnce(params));
  requestChain = pending.catch(() => {});
  return pending;
}

async function requestOnce(params) {
  if (!PANE_ID || !REPORT_URL) return;
  const body = { paneId: PANE_ID, source: SOURCE, agent: AGENT, seq: nextReportSeq(), ...params };
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
  return request({ sessionId: sessionID });
}

function reportState(state, sessionID) {
  const params = { state };
  if (sessionID) {
    reportedRootSessionID = sessionID;
    params.sessionId = sessionID;
  }
  return request(params);
}

// 本地 run/Mini 客户端没有 TUI 插件，由这里拥有生命周期；
// 共享服务器与 TUI worker 的生命周期归各自的 TUI。
function ownsLocalLifecycle() {
  const args = process.argv.slice(2);
  const separator = args.indexOf("--");
  if (separator !== -1) args.splice(separator);
  if (args.some((arg) => arg === "--attach" || arg.startsWith("--attach="))) return false;
  while (args[0] === "--print-logs" || args[0] === "--log-level" || args[0]?.startsWith("--log-level=")) {
    args.splice(0, args[0] === "--log-level" ? 2 : 1);
  }
  return args[0] === "run" ||
    (!["serve", "web", "attach"].includes(args[0]) && args.includes("--mini"));
}

export const HerdrAgentStatePlugin = async () => {
  if (!ownsLocalLifecycle() || !REPORT_URL || !PANE_ID) return {};

  return {
    "chat.message": async ({ sessionID }) => {
      if (sessionID && childSessions.has(sessionID)) return;
      await reportState("working", sessionID);
    },
    event: async ({ event }) => {
      const type = event?.type;
      const properties = event?.properties ?? {};
      const sessionID = sessionIDFromProperties(properties);

      const info = properties.info;
      if (info?.id && info.parentID) {
        childSessions.set(info.id, info.parentID);
      }
      if (sessionID && childSessions.has(sessionID)) {
        const state = CHILD_EVENT_STATES.get(type);
        if (state) {
          let rootSessionID = sessionID;
          while (childSessions.has(rootSessionID)) {
            rootSessionID = childSessions.get(rootSessionID);
          }
          await reportState(state, rootSessionID);
        }
        return;
      }

      switch (type) {
        case "session.created":
          reportedRootSessionID = sessionID;
          break;
        case "session.updated":
          if (sessionID && sessionID !== reportedRootSessionID) {
            await reportSession(sessionID);
          }
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

export default {
  id: "herdr-desktop.opencode",
  server: HerdrAgentStatePlugin,
  setup() {},
};
