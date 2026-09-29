# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=2
$ErrorActionPreference = 'SilentlyContinue'
$action = if ($args.Count -ge 1) { $args[0] } else { 'session' }
$payload = [Console]::In.ReadToEnd()
$sessionId = $null
if ($payload -match '"session_id"\s*:\s*"([^"]+)"') { $sessionId = $Matches[1] }
elseif ($payload -match '"sessionId"\s*:\s*"([^"]+)"') { $sessionId = $Matches[1] }
# SessionStart(source=startup) 是全新会话，可能尚无对话内容，空会话无法 --resume；先不保存，等首个内容事件再报。
$sessionSource = $null
if ($payload -match '"source"\s*:\s*"([^"]+)"') { $sessionSource = $Matches[1] }
if ($action -eq 'session' -and $sessionSource -eq 'startup') { $sessionId = $null }
if (-not $env:HERDR_DESKTOP_REPORT_URL -or -not $env:HERDR_DESKTOP_PANE_ID) { exit 0 }
$agent = if ($env:HERDR_DESKTOP_AGENT) { $env:HERDR_DESKTOP_AGENT } else { 'unknown' }
$body = @{ paneId = $env:HERDR_DESKTOP_PANE_ID; source = "herdr:$agent"; agent = $agent }
if ($sessionId) { $body.sessionId = $sessionId }
if ($action -in @('working','blocked','idle','done')) { $body.state = $action }
$json = $body | ConvertTo-Json -Compress
try { Invoke-RestMethod -Method Post -Uri $env:HERDR_DESKTOP_REPORT_URL -ContentType 'application/json' -Body $json | Out-Null } catch { }
