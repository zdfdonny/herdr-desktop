# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=3
$ErrorActionPreference = 'SilentlyContinue'
$action = if ($args.Count -ge 1) { $args[0] } else { 'session' }
if ($action -ne 'session') { exit 0 }
$payload = [Console]::In.ReadToEnd()
if ($env:CURSOR_VERSION -or $payload -match '"cursor_version"') { exit 0 }
if ($payload -match '"agent_id"\s*:\s*"[^"]') { exit 0 }
if ($payload -notmatch '"hook_event_name"\s*:\s*"SessionStart"') { exit 0 }
$sessionId = $null
if ($payload -match '"session_id"\s*:\s*"([^"]+)"') { $sessionId = $Matches[1] }
$sessionPath = $null
if ($payload -match '"transcript_path"\s*:\s*"([^"]+)"') { $sessionPath = $Matches[1] }
$sessionStartSource = $null
if ($payload -match '"source"\s*:\s*"([^"]+)"') { $sessionStartSource = $Matches[1] }
if (-not $env:HERDR_DESKTOP_REPORT_URL -or -not $env:HERDR_DESKTOP_PANE_ID) { exit 0 }
if (-not $sessionId) { exit 0 }
$body = @{ paneId = $env:HERDR_DESKTOP_PANE_ID; source = 'herdr:claude'; agent = 'claude'; sessionId = $sessionId }
if ($sessionPath) { $body.sessionPath = $sessionPath }
if ($sessionStartSource) { $body.sessionStartSource = $sessionStartSource }
$json = $body | ConvertTo-Json -Compress
try { Invoke-RestMethod -Method Post -Uri $env:HERDR_DESKTOP_REPORT_URL -ContentType 'application/json' -Body $json | Out-Null } catch { }
