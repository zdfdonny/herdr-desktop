# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=3
$ErrorActionPreference = 'SilentlyContinue'
$action = if ($args.Count -ge 1) { $args[0] } else { 'session' }
if ($action -ne 'session') { exit 0 }
$payload = [Console]::In.ReadToEnd()
$hookEvent = $null
if ($payload -match '"hook_event_name"\s*:\s*"([^"]+)"') { $hookEvent = $Matches[1] }
if ($hookEvent -and $hookEvent -notin @('session_start','SessionStart','sessionStart')) { exit 0 }
$sessionId = if ($env:GROK_SESSION_ID) { $env:GROK_SESSION_ID } else { $null }
if (-not $sessionId) {
  if ($payload -match '"session_id"\s*:\s*"([^"]+)"') { $sessionId = $Matches[1] }
  elseif ($payload -match '"sessionId"\s*:\s*"([^"]+)"') { $sessionId = $Matches[1] }
}
$sessionStartSource = $null
if ($payload -match '"source"\s*:\s*"([^"]+)"') { $sessionStartSource = $Matches[1] }
if (-not $env:HERDR_DESKTOP_REPORT_URL -or -not $env:HERDR_DESKTOP_PANE_ID) { exit 0 }
if (-not $sessionId) { exit 0 }
$body = @{ paneId = $env:HERDR_DESKTOP_PANE_ID; source = 'herdr:grok'; agent = 'grok'; sessionId = $sessionId }
if ($sessionStartSource) { $body.sessionStartSource = $sessionStartSource }
$json = $body | ConvertTo-Json -Compress
try { Invoke-RestMethod -Method Post -Uri $env:HERDR_DESKTOP_REPORT_URL -ContentType 'application/json' -Body $json | Out-Null } catch { }
