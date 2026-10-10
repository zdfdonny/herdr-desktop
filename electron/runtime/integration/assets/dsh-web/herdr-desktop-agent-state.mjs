// HERDR_INTEGRATION_ID=herdr-desktop
// HERDR_INTEGRATION_VERSION=4
// Self-contained DeepSeek Harness plugin.
//
// Responsibilities (active only when launched by herdr-desktop, i.e. when
// HERDR_DESKTOP_REPORT_URL is present):
// 1. Register every project directory herdr-desktop opens as a DSH workspace.
//    Per registration, resolve the session the GUI should land on:
//    - create  -> always create a fresh blank session;
//    - restore -> leave the pane's own localStorage selection untouched (the
//      pane restores the session it was last using).
// 2. Report DSH agent state per session (working / blocked / idle) back to
//    herdr-desktop, carrying the session id. herdr-desktop routes each report
//    to the pane that is currently bound to that session (see WebPane binding),
//    so multiple panes in one project can show independent states.

export const name = 'herdr-desktop-agent-state'

const REPORT_URL = process.env.HERDR_DESKTOP_REPORT_URL
const CWD = process.env.HERDR_DESKTOP_CWD || ''
const PANE_ID = process.env.HERDR_DESKTOP_PANE_ID || ''

const SOURCE = 'herdr:dsh'
const AGENT = 'dsh'
// The herdr-desktop main process calls this route after acquiring the shared
// process to push the cwd/paneId of the second and subsequent projects at
// runtime (the shared single process never receives the later env).
const REGISTER_PATH = '/herdr-desktop/register-workspace'

export function apply(ctx) {
  // No-op when not launched by herdr-desktop; never affects any other dsh process.
  if (!REPORT_URL) return

  let workspaceRegistry = null
  let sessionController = null
  let webServer = null

  // cwd (project directory) -> paneIds. Used as the fallback broadcast target
  // for a session's reports: herdr-desktop may redirect to the exact bound pane,
  // but broadcasting to the project's panes keeps unbound panes updated too.
  const cwdToPaneIds = new Map()
  if (CWD && PANE_ID) cwdToPaneIds.set(CWD, new Set([PANE_ID]))

  // sessionId -> cwd: attribute sessionId-keyed events back to their project.
  const sessionCwd = new Map()

  // sessionId -> { running, blocked, askUserCallId, turnEndKind, cwd }
  // Per-session state (not project-level aggregation).
  // `blocked` covers two cases: permission approval (approval/asked) and the
  // ask_user_question tool waiting for the user's answer.
  // `turnEndKind` records the last turn's end reason, to distinguish a normal
  // completion from a manual stop.
  const sessionState = new Map()

  // Monotonic report sequence.
  let seq = 0

  // ---------- helpers ----------

  function cwdOfSession(session) {
    if (session && session.header && typeof session.header.cwd === 'string') {
      return session.header.cwd
    }
    return null
  }

  function ensureSessionState(sessionId, cwd) {
    let st = sessionState.get(sessionId)
    if (!st) {
      st = { running: false, blocked: null, askUserCallId: null, turnEndKind: null, cwd }
      sessionState.set(sessionId, st)
    }
    return st
  }

  /** Per-session state: blocked > working > idle. */
  function stateForSession(st) {
    if (st.blocked) return { state: 'blocked', message: st.blocked }
    if (st.running) return { state: 'working', message: null }
    return { state: 'idle', message: null }
  }

  /** Broadcast one session's state to the project's panes (fallback routing). */
  function reportForSession(sessionId, replay) {
    const st = sessionState.get(sessionId)
    if (!st) return
    const paneIds = cwdToPaneIds.get(st.cwd)
    if (!paneIds || paneIds.size === 0) return
    const agg = stateForSession(st)
    const seqNow = ++seq
    for (const paneId of paneIds) {
      const body = {
        paneId,
        source: SOURCE,
        agent: AGENT,
        state: agg.state,
        sessionPath: st.cwd,
        seq: seqNow,
        sessionId,
      }
      // Replay after a binding switch: mark it so Main skips sound/toast.
      if (replay) body.replay = true
      // When idle, carry the turn's end reason: completed -> normal done;
      // aborted (manual stop) -> plain idle (no done).
      if (agg.state === 'idle' && st.turnEndKind) {
        body.completion = st.turnEndKind
      }
      if (agg.message) body.message = agg.message
      fetch(REPORT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(function () {})
    }
  }

  function registerWorkspace(cwd) {
    if (!cwd || !workspaceRegistry || typeof workspaceRegistry.create !== 'function') {
      return Promise.resolve(null)
    }
    // create is idempotent: returns the existing workspace when already registered.
    return workspaceRegistry.create(cwd).catch(function () {
      return null
    })
  }

  function createBlankSession(ws) {
    if (!ws || !ws.id || !sessionController || typeof sessionController.create !== 'function') {
      return Promise.resolve(null)
    }
    return sessionController.create({ workspaceId: ws.id }).catch(function () {
      return null
    })
  }

  // Resolve the session id the GUI should land on, based on the intent:
  // - create  -> always create a fresh blank session and return its id;
  // - restore -> return null for a non-empty project (let the pane partition's
  //   existing localStorage restore the session it was last using); for an empty
  //   project create one blank session so the GUI has somewhere to land.
  // herdr-desktop writes a non-null id into the pane partition's localStorage
  // ("dsh.sessions.current"); a null id means "do not overwrite localStorage".
  async function resolveLandingSession(ws, mode) {
    if (!ws || !ws.id) return null
    const ids = Array.isArray(ws.sessionIds) ? ws.sessionIds : []
    if (mode === 'restore' && ids.length > 0) return null
    const created = await createBlankSession(ws)
    return created && typeof created.sessionId === 'string' ? created.sessionId : null
  }

  // ---------- session lifecycle (scoped events; needs global to see every agent) ----------

  ctx.on('session/created', function (session) {
    const cwd = cwdOfSession(session)
    if (!cwd) return
    sessionCwd.set(session.id, cwd)
    ensureSessionState(session.id, cwd)
    // Deliberately do NOT register the workspace here: this fires for every
    // session (including subagent/fork sessions), and registering their cwd
    // would pollute the workspace list with subdirectories. Workspace
    // registration is owned by the registration route.
  }, { global: true })

  ctx.on('session/disposed', function (session) {
    const st = sessionState.get(session.id)
    const cwd = sessionCwd.get(session.id) || (st && st.cwd)
    if (!cwd) {
      sessionCwd.delete(session.id)
      sessionState.delete(session.id)
      return
    }
    sessionCwd.delete(session.id)
    sessionState.delete(session.id)
    // Report idle so any pane still showing this session falls back to idle.
    reportIdle(cwd, session.id)
  }, { global: true })

  // agent status -> running/idle (api-session/status is keyed by sessionId, no scope filter).
  ctx.on('api-session/status', function (sessionId, running) {
    const st = sessionState.get(sessionId)
    if (!st) return
    st.running = !!running
    reportForSession(sessionId)
  })

  // session events -> blocked state. Two kinds of "waiting for the user":
  // - approval/asked: permission decision (allow / reject);
  // - tool/call of ask_user_question: the model asked the user a question / choice
  //   and is awaiting the answer; it stays blocked until tool/result closes it.
  ctx.on('session/event', function (session, event) {
    if (!event) return
    let cwd = sessionCwd.get(session.id)
    if (!cwd) {
      cwd = cwdOfSession(session)
      if (cwd) sessionCwd.set(session.id, cwd)
    }
    if (!cwd) return
    const st = ensureSessionState(session.id, cwd)
    const data = event.data || {}
    if (event.type === 'approval/asked') {
      st.blocked = data.reason || data.toolName || 'approval'
      reportForSession(session.id)
    } else if (event.type === 'approval/decided') {
      st.blocked = null
      reportForSession(session.id)
    } else if (event.type === 'tool/call' && data.name === 'ask_user_question') {
      // The model issued ask_user_question and is awaiting the user's answer.
      st.blocked = 'Waiting for user choice'
      st.askUserCallId = typeof data.callId === 'string' ? data.callId : null
      reportForSession(session.id)
    } else if (event.type === 'tool/result' && st.askUserCallId) {
      const msg = data.message
      const callId =
        (msg && typeof msg.toolCallId === 'string' && msg.toolCallId) ||
        (msg && msg.source && typeof msg.source.callId === 'string' && msg.source.callId) ||
        null
      if (callId && callId === st.askUserCallId) {
        st.askUserCallId = null
        st.blocked = null
        reportForSession(session.id)
      }
    } else if (event.type === 'turn/start') {
      // A new turn begins; the previous end reason no longer applies.
      st.turnEndKind = null
    } else if (event.type === 'turn/end') {
      // Record the end reason: completed (normal) vs aborted+user (manual stop).
      const reason = data.reason
      if (reason && reason.kind === 'completed') {
        st.turnEndKind = 'completed'
      } else if (
        reason &&
        reason.kind === 'aborted' &&
        reason.reason &&
        reason.reason.kind === 'user'
      ) {
        st.turnEndKind = 'aborted'
      } else {
        st.turnEndKind = null
      }
    }
  }, { global: true })

  /** Broadcast an explicit idle state for a disposed session. */
  function reportIdle(cwd, sessionId) {
    const paneIds = cwdToPaneIds.get(cwd)
    if (!paneIds || paneIds.size === 0) return
    const seqNow = ++seq
    for (const paneId of paneIds) {
      fetch(REPORT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paneId,
          source: SOURCE,
          agent: AGENT,
          state: 'idle',
          sessionPath: cwd,
          seq: seqNow,
          sessionId,
        }),
      }).catch(function () {})
    }
  }

  // ---------- after services resolve: register first project + mount runtime registration route ----------

  ctx.inject(['workspaceRegistry', 'sessionController', 'webServer'], function (c) {
    try {
      workspaceRegistry = c && (c.workspaceRegistry || (typeof c.get === 'function' ? c.get('workspaceRegistry') : null))
      sessionController = c && (c.sessionController || (typeof c.get === 'function' ? c.get('sessionController') : null))
      webServer = c && (c.webServer || (typeof c.get === 'function' ? c.get('webServer') : null))
    } catch (error) {
      // Injection shape differences; treat read failures as null and let each branch null-check.
    }

    // First project: register its workspace early so the GUI never sees an empty
    // workspace list. Session creation is handled by the registration route below,
    // which knows whether this pane is being created or restored.
    void (async function () {
      const cwd = CWD || process.cwd()
      await registerWorkspace(cwd)
    })().catch(function () {})

    // Runtime channel: subsequent projects are POSTed in by the herdr-desktop main process.
    if (webServer && typeof webServer.register === 'function') {
      webServer.register({
        kind: 'exact',
        path: REGISTER_PATH,
        handler: async function (req, res) {
          if (req.method !== 'POST') {
            res.writeHead(404).end()
            return
          }
          try {
            const body = await readBody(req, 64 * 1024)
            const parsed = JSON.parse(body)
            const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : ''
            const paneId = typeof parsed.paneId === 'string' ? parsed.paneId : ''
            const mode =
              parsed.mode === 'restore'
                ? 'restore'
                : parsed.mode === 'unregister'
                  ? 'unregister'
                  : parsed.mode === 'replay'
                    ? 'replay'
                    : 'create'
            if (!cwd && mode !== 'replay') {
              res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false }))
              return
            }
            if (mode === 'replay') {
              // Pane switched sessions (or restarted): re-report this session's
              // current state with our own monotonic seq, so the newly-bound pane
              // refreshes (replay=true tells Main to skip sound/toast).
              const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
              const replayPaneId = typeof parsed.paneId === 'string' ? parsed.paneId : ''
              if (sessionId) {
                const st = sessionState.get(sessionId)
                // Ensure the requesting pane is in the broadcast set even if its
                // register-workspace call has not landed yet (restart race), so the
                // re-reported state is actually delivered back to that pane.
                if (st && replayPaneId) {
                  let set = cwdToPaneIds.get(st.cwd)
                  if (!set) {
                    set = new Set()
                    cwdToPaneIds.set(st.cwd, set)
                  }
                  set.add(replayPaneId)
                }
                reportForSession(sessionId, true)
              }
              res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }))
              return
            }
            if (mode === 'unregister') {
              // Pane closed: drop it from the broadcast map, and reclaim the whole
              // cwd entry once no pane is left watching it.
              if (cwd && paneId) {
                const set = cwdToPaneIds.get(cwd)
                if (set) {
                  set.delete(paneId)
                  if (set.size === 0) {
                    cwdToPaneIds.delete(cwd)
                  }
                }
              }
              res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }))
              return
            }
            if (cwd && paneId) {
              let set = cwdToPaneIds.get(cwd)
              if (!set) {
                set = new Set()
                cwdToPaneIds.set(cwd, set)
              }
              set.add(paneId)
            }
            const ws = await registerWorkspace(cwd)
            const sessionId = await resolveLandingSession(ws, mode)
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(
              JSON.stringify({ ok: true, workspaceId: ws && ws.id ? String(ws.id) : null, sessionId: sessionId || null }),
            )
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false }))
          }
        },
      })
    }
  })
}

/** Read the request body (at most maxBytes). */
function readBody(req, maxBytes) {
  return new Promise(function (resolve, reject) {
    let size = 0
    const chunks = []
    req.on('data', function (chunk) {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}
