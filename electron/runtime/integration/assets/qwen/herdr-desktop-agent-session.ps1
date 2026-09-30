# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=3
$ErrorActionPreference = 'SilentlyContinue'
$action = if ($args.Count -ge 1) { $args[0] } else { 'session' }
if ($action -ne 'session') { exit 0 }
$payload = [Console]::In.ReadToEnd()
$sessionId = $null
if ($payload -match '"session_id"\s*:\s*"([^"]+)"') { $sessionId = $Matches[1] }
$sessionStartSource = $null
if ($payload -match '"source"\s*:\s*"([^"]+)"' -and $Matches[1] -in @('startup','resume','clear','compact','branch')) { $sessionStartSource = $Matches[1] }
if (-not $env:HERDR_DESKTOP_REPORT_URL -or -not $env:HERDR_DESKTOP_PANE_ID) { exit 0 }
if (-not $sessionId) { exit 0 }
$body = @{ paneId = $env:HERDR_DESKTOP_PANE_ID; source = 'herdr:qwen'; agent = 'qwen'; sessionId = $sessionId }
if ($sessionStartSource) { $body.sessionStartSource = $sessionStartSource }
$json = $body | ConvertTo-Json -Compress
try { Invoke-RestMethod -Method Post -Uri $env:HERDR_DESKTOP_REPORT_URL -ContentType 'application/json' -Body $json | Out-Null } catch { }
