# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=4
#
# antigravity (agy) hook: report session identity + agent state.
#
# Why state reporting: screen detection cannot tell "init finished" from
# "tool finished" from "turn really finished" -- all three look like the
# spinner stopping, so each one produced a working->idle transition and
# played the completion sound. The hooks bracket the whole turn:
#   PreInvocation -> working (fires several times per turn, no transition)
#   Stop + fullyIdle=true -> idle (the only real completion)
# A finished tool emits nothing, so it no longer rings the sound.
#
# NOTE: this file must stay ASCII-only. Windows PowerShell 5.1 decodes a
# UTF-8 file without BOM as ANSI, so non-ASCII comments corrupt the parse
# (observed: a CJK comment swallowed the next line). Same reason every
# other *.ps1 asset in this repo is ASCII-only.
#
# NOTE: agy mangles quotes around -File arguments, so the installer uses
# -EncodedCommand instead.
$ErrorActionPreference = 'SilentlyContinue'
$action = if ($args.Count -ge 1) { $args[0] } else { 'session' }
if ($action -ne 'session' -and $action -ne 'stop') { exit 0 }
$payload = [Console]::In.ReadToEnd()
$sessionId = $null
if ($payload -match '"conversationId"\s*:\s*"([^"]+)"') { $sessionId = $Matches[1] }
$sessionPath = $null
if ($payload -match '"transcriptPath"\s*:\s*"([^"]+)"') { $sessionPath = $Matches[1] }
if (-not $env:HERDR_DESKTOP_REPORT_URL -or -not $env:HERDR_DESKTOP_PANE_ID) { exit 0 }
if (-not $sessionId) { exit 0 }

# Monotonic sequence: millisecond timestamp is enough (hooks are spaced by
# hundreds of ms) and is used to drop out-of-order reports.
$seqValue = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$body = @{
  paneId    = $env:HERDR_DESKTOP_PANE_ID
  source    = 'herdr:antigravity'
  agent     = 'antigravity'
  sessionId = $sessionId
  seq       = $seqValue
}
if ($sessionPath) { $body.sessionPath = $sessionPath }

if ($action -eq 'stop') {
  # Stop: the model finished this turn. Only a *fully idle* Stop is a real
  # completion. Anything else must report nothing at all -- in particular a
  # pending permission prompt arrives together with Stop (fullyIdle=false),
  # and reporting 'working' here would stomp the screen's blocked signal,
  # making the prompt ring only every other time.
  if ($payload -notmatch '"fullyIdle"\s*:\s*true') { exit 0 }
  $reason = $null
  if ($payload -match '"terminationReason"\s*:\s*"([^"]*)"') { $reason = $Matches[1] }
  $errorText = $null
  if ($payload -match '"error"\s*:\s*"([^"]+)"') { $errorText = $Matches[1] }
  $body.state = 'idle'
  $message = $reason
  if ($errorText) {
    if ($reason) { $message = "$reason ($errorText)" } else { $message = $errorText }
  }
  if ($message) { $body.message = $message }
} else {
  # session (PreInvocation): a model invocation started.
  $body.state = 'working'
}

$json = $body | ConvertTo-Json -Compress
try { Invoke-RestMethod -Method Post -Uri $env:HERDR_DESKTOP_REPORT_URL -ContentType 'application/json' -Body $json | Out-Null } catch { }
