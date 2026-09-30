# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=3
$ErrorActionPreference = 'SilentlyContinue'
$action = if ($args.Count -ge 1) { $args[0] } else { 'session' }
if ($action -notin @('session','working','blocked','idle')) { exit 0 }
$payload = [Console]::In.ReadToEnd()
$sessionId = $null
if ($payload -match '"session_id"\s*:\s*"([^"]+)"') { $sessionId = $Matches[1] }
if (-not $env:HERDR_DESKTOP_REPORT_URL -or -not $env:HERDR_DESKTOP_PANE_ID) { exit 0 }
if (-not $sessionId) { exit 0 }
$body = @{ paneId = $env:HERDR_DESKTOP_PANE_ID; source = 'herdr:kimi'; agent = 'kimi'; sessionId = $sessionId }
if ($action -eq 'session') { $body.sessionStartSource = 'startup' } else { $body.state = $action }
$json = $body | ConvertTo-Json -Compress
try { Invoke-RestMethod -Method Post -Uri $env:HERDR_DESKTOP_REPORT_URL -ContentType 'application/json' -Body $json | Out-Null } catch { }
