# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=3
$ErrorActionPreference = 'SilentlyContinue'
$action = if ($args.Count -ge 1) { $args[0] } else { 'session' }
if ($action -ne 'session') { exit 0 }
$payload = [Console]::In.ReadToEnd()
$conversationId = $null
if ($payload -match '"conversation_id"\s*:\s*"([^"]+)"') { $conversationId = $Matches[1] }
$agentId = $null
if ($payload -match '"agent_id"\s*:\s*"([^"]+)"') { $agentId = $Matches[1] }
if ($conversationId -eq 'default') {
  if (-not $agentId) { exit 0 }
  $sessionId = "default:$agentId"
} else {
  $sessionId = $conversationId
}
$sessionStartSource = if ($payload -match '"is_new_session"\s*:\s*true') { 'new' } else { 'resume' }
if (-not $env:HERDR_DESKTOP_REPORT_URL -or -not $env:HERDR_DESKTOP_PANE_ID) { exit 0 }
if (-not $sessionId) { exit 0 }
$body = @{ paneId = $env:HERDR_DESKTOP_PANE_ID; source = 'herdr:letta'; agent = 'letta'; sessionId = $sessionId; sessionStartSource = $sessionStartSource }
$json = $body | ConvertTo-Json -Compress
try { Invoke-RestMethod -Method Post -Uri $env:HERDR_DESKTOP_REPORT_URL -ContentType 'application/json' -Body $json | Out-Null } catch { }
