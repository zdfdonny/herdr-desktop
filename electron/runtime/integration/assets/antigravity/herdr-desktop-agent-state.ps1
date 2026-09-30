# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=3
$ErrorActionPreference = 'SilentlyContinue'
$action = if ($args.Count -ge 1) { $args[0] } else { 'session' }
if ($action -ne 'session') { exit 0 }
$payload = [Console]::In.ReadToEnd()
$sessionId = $null
if ($payload -match '"conversationId"\s*:\s*"([^"]+)"') { $sessionId = $Matches[1] }
$sessionPath = $null
if ($payload -match '"transcriptPath"\s*:\s*"([^"]+)"') { $sessionPath = $Matches[1] }
if (-not $env:HERDR_DESKTOP_REPORT_URL -or -not $env:HERDR_DESKTOP_PANE_ID) { exit 0 }
if (-not $sessionId) { exit 0 }
$body = @{ paneId = $env:HERDR_DESKTOP_PANE_ID; source = 'herdr:antigravity'; agent = 'antigravity'; sessionId = $sessionId }
if ($sessionPath) { $body.sessionPath = $sessionPath }
$json = $body | ConvertTo-Json -Compress
try { Invoke-RestMethod -Method Post -Uri $env:HERDR_DESKTOP_REPORT_URL -ContentType 'application/json' -Body $json | Out-Null } catch { }
