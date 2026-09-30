# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=3
$ErrorActionPreference = 'SilentlyContinue'
$action = if ($args.Count -ge 1) { $args[0] } else { 'session' }
if ($action -notin @('session','working','idle')) { exit 0 }
$payload = [Console]::In.ReadToEnd()
$hookEvent = $null
if ($payload -match '"hook_event_name"\s*:\s*"([^"]+)"') { $hookEvent = $Matches[1] }
$expected = switch ($action) { 'session' { '^SessionStart$' } 'working' { '^UserPromptSubmit$' } 'idle' { '^(Stop|Interrupt)$' } }
if ($hookEvent -and $hookEvent -notmatch $expected) { exit 0 }
$sessionId = $null
if ($payload -match '"session_id"\s*:\s*"([^"]+)"') { $sessionId = $Matches[1] }
if ($env:CODEX_THREAD_ID -and $sessionId -and $env:CODEX_THREAD_ID -ne $sessionId) { exit 0 }
$sessionStartSource = $null
if ($action -eq 'session') {
  if ($payload -notmatch '"transcript_path"\s*:\s*"[^"]') { exit 0 }
  if ($payload -match '"source"\s*:\s*"([^"]+)"') { $sessionStartSource = $Matches[1] }
}
if (-not $env:HERDR_DESKTOP_REPORT_URL -or -not $env:HERDR_DESKTOP_PANE_ID) { exit 0 }
if (-not $sessionId) { exit 0 }
$body = @{ paneId = $env:HERDR_DESKTOP_PANE_ID; source = 'herdr:codex'; agent = 'codex'; sessionId = $sessionId }
if ($action -in @('working','idle')) { $body.state = $action }
if ($sessionStartSource) { $body.sessionStartSource = $sessionStartSource }
$json = $body | ConvertTo-Json -Compress
try { Invoke-RestMethod -Method Post -Uri $env:HERDR_DESKTOP_REPORT_URL -ContentType 'application/json' -Body $json | Out-Null } catch { }
