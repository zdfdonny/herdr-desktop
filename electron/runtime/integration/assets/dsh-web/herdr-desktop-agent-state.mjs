// HERDR_INTEGRATION_ID=herdr-desktop
// HERDR_INTEGRATION_VERSION=2
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
