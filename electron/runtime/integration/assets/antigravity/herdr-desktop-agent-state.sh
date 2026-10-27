#!/usr/bin/env bash
# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=5
#
# antigravity (agy) hook for non-Windows hosts: report session identity + state.
# Same logic as the .ps1 asset; see its header for the rationale:
#   PreInvocation -> working, Stop with fullyIdle=true -> idle.
# A completed tool emits nothing, so finishing a tool no longer rings the
# completion sound by mistake.
set -u
action="${1:-session}"
[ "$action" = "session" ] || [ "$action" = "stop" ] || exit 0
payload="$(cat)"
session_id="$(printf '%s' "$payload" | sed -n 's/.*"conversationId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
session_path="$(printf '%s' "$payload" | sed -n 's/.*"transcriptPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -n "${HERDR_DESKTOP_REPORT_URL:-}" ] || exit 0
[ -n "${HERDR_DESKTOP_PANE_ID:-}" ] || exit 0
[ -n "$session_id" ] || exit 0

# Deliberately no seq field: there is no portable way to read a millisecond
# timestamp here. GNU date supports %3N but the BSD date shipped with macOS does
# not, so every report would carry the same value and the host -- which requires
# seq to increase strictly -- would drop all but the first one (observable as
# "no completion sound on macOS"). When seq is absent the main process supplies
# a strictly increasing one (see router.reportAgentSession).
body="{\"paneId\":\"$HERDR_DESKTOP_PANE_ID\",\"source\":\"herdr:antigravity\",\"agent\":\"antigravity\",\"sessionId\":\"$session_id\""
[ -n "$session_path" ] && body="$body,\"sessionPath\":\"$session_path\""

if [ "$action" = "stop" ]; then
  # Stop: the execution loop ended. Report idle in every case except one:
  # "normal completion while background tasks are still running"
  # (terminationReason=NO_TOOL_CALL && fullyIdle=false).
  #
  # Why not gate purely on fullyIdle: pressing Esc cancels the turn with
  # terminationReason=USER_CANCELED, and fullyIdle can still be false (the
  # cancelled execution counts as a background task). Gating on fullyIdle alone
  # left the pane stuck in working forever after a manual cancel.
  #
  # terminationReason enum (from the CLI's own hook contract):
  #   NO_TOOL_CALL / MAX_INVOCATIONS / MAX_FORCED_INVOCATIONS /
  #   MAX_TOKEN_BUDGET_EXCEEDED / ERROR / USER_CANCELED /
  #   TERMINAL_STEP_TYPE / TERMINAL_CUSTOM_HOOK / INJECTED_RESPONSE
  reason="$(printf '%s' "$payload" | sed -n 's/.*"terminationReason"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  error_text="$(printf '%s' "$payload" | sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [ "$reason" = "NO_TOOL_CALL" ] &&
     ! printf '%s' "$payload" | grep -q '"fullyIdle"[[:space:]]*:[[:space:]]*true'; then
    exit 0
  fi
  message="$reason"
  if [ -n "$error_text" ]; then
    if [ -n "$reason" ]; then message="$reason ($error_text)"; else message="$error_text"; fi
  fi
  body="$body,\"state\":\"idle\""
  [ -n "$message" ] && body="$body,\"message\":$(printf '%s' "$message" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')"
else
  body="$body,\"state\":\"working\""
fi
body="$body}"
curl -s -X POST "$HERDR_DESKTOP_REPORT_URL" -H 'Content-Type: application/json' --data "$body" >/dev/null 2>&1 || true
