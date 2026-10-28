# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=4
#
# claude hook: report session identity + agent state. Same logic as the .sh
# asset; that file carries the long-form rationale. Summary:
#   SessionStart     -> session (bind session id / transcript)
#   UserPromptSubmit -> working (turn start: the only idle -> working edge)
#   PostToolUse      -> tick (heartbeat: refresh working, never revive idle)
#   Stop             -> idle (the only real completion point)
#   StopFailure      -> idle + completion=aborted (no finish sound)
#
# The tick/heartbeat split matters because these two hooks run async while Stop
# is synchronous: a late heartbeat must not flip a finished pane back to working
# (that loses the finish sound and projects a second "done" badge). See
# TerminalState.isStaleHeartbeat.
#
# blocked is deliberately NOT reported: Claude Code has no "permission granted"
# event, so a blocked report from PermissionRequest would stick until
# PostToolUse fires - i.e. the pane would keep showing "waiting for input" for
# the whole time an approved long-running command runs. Permission dialogs stay
# on screen detection, which reacts the moment the dialog appears/disappears.
#
# A user interrupt (Esc) fires no Stop at all; the last working report expires
# after the main process's 1.5s TTL (HOOK_WORKING_TTL_MS) and the screen takes
# over again, so nothing extra is needed here.
#
# NOTE: this file must stay ASCII-only. Windows PowerShell 5.1 decodes a
# UTF-8 file without BOM as ANSI, so non-ASCII comments corrupt the parse
# (observed: a CJK comment swallowed the next line). Same reason every
# other *.ps1 asset in this repo is ASCII-only.
$ErrorActionPreference = 'SilentlyContinue'
$action = if ($args.Count -ge 1) { $args[0] } else { 'session' }
if ($action -notin @('session', 'working', 'tick', 'idle', 'failed')) { exit 0 }
$payload = [Console]::In.ReadToEnd()
# Scan only the PREFIX of the payload. Common fields (session_id,
# hook_event_name, agent_id, ...) come first; the event-specific free-form
# payloads (tool_input, tool_response, prompt, last_assistant_message) follow,
# and nested objects in those can carry the SAME key names - e.g. writing a
# JSON file that contains agent_id, or writing a hooks config that contains
# hook_event_name. Matching the whole payload drops real reports in those
# cases. Text inside string values is not a concern: JSON escapes its quotes
# as \" so a bare-quote pattern cannot match it. Each -replace only trims the
# tail, so applying them all leaves the text before the earliest such key.
# This assumes the common fields (agent_id included) come before the
# event-specific ones; if that order ever changes, the subagent filter
# degrades to not filtering (an extra status report, never a stuck state).
$scan = $payload
$scan = $scan -replace '"tool_input"[\s\S]*$', ''
$scan = $scan -replace '"tool_response"[\s\S]*$', ''
$scan = $scan -replace '"prompt"[\s\S]*$', ''
$scan = $scan -replace '"last_assistant_message"[\s\S]*$', ''
if ($env:CURSOR_VERSION -or $scan -match '"cursor_version"') { exit 0 }
# Subagent events carry agent_id; a subagent's Stop must not read as "task done".
if ($scan -match '"agent_id"\s*:\s*"[^"]') { exit 0 }
# PowerShell's -match takes the FIRST occurrence, unlike a greedy sed.
$hookEvent = $null
if ($scan -match '"hook_event_name"\s*:\s*"([^"]*)"') { $hookEvent = $Matches[1] }
$expected = switch ($action) {
  'session' { '^SessionStart$' }
  'working' { '^UserPromptSubmit$' }
  'tick' { '^PostToolUse$' }
  'idle' { '^Stop$' }
  'failed' { '^StopFailure$' }
}
# One action may be registered on several events; drop anything that drifts.
if ($hookEvent -and ($hookEvent -notmatch $expected)) { exit 0 }
$sessionId = $null
if ($scan -match '"session_id"\s*:\s*"([^"]+)"') { $sessionId = $Matches[1] }
$sessionPath = $null
if ($scan -match '"transcript_path"\s*:\s*"([^"]+)"') { $sessionPath = $Matches[1] }
$sessionStartSource = $null
if ($scan -match '"source"\s*:\s*"([^"]+)"') { $sessionStartSource = $Matches[1] }
if (-not $env:HERDR_DESKTOP_REPORT_URL -or -not $env:HERDR_DESKTOP_PANE_ID) { exit 0 }
if (-not $sessionId) { exit 0 }
$body = @{
  paneId    = $env:HERDR_DESKTOP_PANE_ID
  source    = 'herdr:claude'
  agent     = 'claude'
  sessionId = $sessionId
}
# No seq on purpose (see the .sh asset): the main process fills in a strictly
# increasing one, because a non-increasing value drops the report entirely.
switch ($action) {
  'session' {
    if ($sessionPath) { $body.sessionPath = $sessionPath }
    if ($sessionStartSource) { $body.sessionStartSource = $sessionStartSource }
  }
  'working' { $body.state = 'working' }
  'tick' {
    # Heartbeat only: may refresh a working pane, never revive an idle one.
    $body.state = 'working'
    $body.heartbeat = $true
  }
  'idle' { $body.state = 'idle' }
  'failed' {
    $body.state = 'idle'
    $body.completion = 'aborted'
  }
}
$json = $body | ConvertTo-Json -Compress
try { Invoke-RestMethod -Method Post -Uri $env:HERDR_DESKTOP_REPORT_URL -ContentType 'application/json' -Body $json | Out-Null } catch { }
