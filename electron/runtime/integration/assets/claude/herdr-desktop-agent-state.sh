#!/usr/bin/env bash
# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=3
set -u
action="${1:-session}"
[ "$action" = "session" ] || exit 0
payload="$(cat)"
# filter cursor events
if [ -n "${CURSOR_VERSION:-}" ] || printf '%s' "$payload" | grep -q '"cursor_version"'; then exit 0; fi
# filter subagent events
if printf '%s' "$payload" | grep -q '"agent_id"[[:space:]]*:[[:space:]]*"[^"]'; then exit 0; fi
# SessionStart only
hook_event="$(printf '%s' "$payload" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ "$hook_event" = "SessionStart" ] || exit 0
session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
session_path="$(printf '%s' "$payload" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
session_start_source="$(printf '%s' "$payload" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -n "$HERDR_DESKTOP_REPORT_URL" ] || exit 0
[ -n "$HERDR_DESKTOP_PANE_ID" ] || exit 0
[ -n "$session_id" ] || exit 0
body="{\"paneId\":\"$HERDR_DESKTOP_PANE_ID\",\"source\":\"herdr:claude\",\"agent\":\"claude\""
[ -n "$session_id" ] && body="$body,\"sessionId\":\"$session_id\""
[ -n "$session_path" ] && body="$body,\"sessionPath\":\"$session_path\""
[ -n "$session_start_source" ] && body="$body,\"sessionStartSource\":\"$session_start_source\""
body="$body}"
curl -s -X POST "$HERDR_DESKTOP_REPORT_URL" -H 'Content-Type: application/json' --data "$body" >/dev/null 2>&1 || true
