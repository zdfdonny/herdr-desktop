#!/usr/bin/env bash
# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=3
set -u
action="${1:-session}"
[ "$action" = "session" ] || exit 0
payload="$(cat)"
hook_event="$(printf '%s' "$payload" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
case "$hook_event" in ''|session_start|SessionStart|sessionStart) ;; *) exit 0 ;; esac
session_id="${GROK_SESSION_ID:-}"
[ -z "$session_id" ] && session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -z "$session_id" ] && session_id="$(printf '%s' "$payload" | sed -n 's/.*"sessionId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
session_start_source="$(printf '%s' "$payload" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -n "$HERDR_DESKTOP_REPORT_URL" ] || exit 0
[ -n "$HERDR_DESKTOP_PANE_ID" ] || exit 0
[ -n "$session_id" ] || exit 0
body="{\"paneId\":\"$HERDR_DESKTOP_PANE_ID\",\"source\":\"herdr:grok\",\"agent\":\"grok\""
[ -n "$session_id" ] && body="$body,\"sessionId\":\"$session_id\""
[ -n "$session_start_source" ] && body="$body,\"sessionStartSource\":\"$session_start_source\""
body="$body}"
curl -s -X POST "$HERDR_DESKTOP_REPORT_URL" -H 'Content-Type: application/json' --data "$body" >/dev/null 2>&1 || true
