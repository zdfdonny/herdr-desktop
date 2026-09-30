#!/usr/bin/env bash
# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=3
set -u
action="${1:-session}"
case "$action" in session|working|blocked|idle) ;; *) exit 0 ;; esac
payload="$(cat)"
session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
session_start_source=""
[ "$action" = "session" ] && session_start_source="startup"
[ -n "$HERDR_DESKTOP_REPORT_URL" ] || exit 0
[ -n "$HERDR_DESKTOP_PANE_ID" ] || exit 0
[ -n "$session_id" ] || exit 0
body="{\"paneId\":\"$HERDR_DESKTOP_PANE_ID\",\"source\":\"herdr:kimi\",\"agent\":\"kimi\""
[ -n "$session_id" ] && body="$body,\"sessionId\":\"$session_id\""
[ -n "$session_start_source" ] && body="$body,\"sessionStartSource\":\"$session_start_source\""
case "$action" in working|blocked|idle|done) body="$body,\"state\":\"$action\"";; esac
body="$body}"
curl -s -X POST "$HERDR_DESKTOP_REPORT_URL" -H 'Content-Type: application/json' --data "$body" >/dev/null 2>&1 || true
