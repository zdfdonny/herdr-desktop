#!/usr/bin/env bash
# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=3
set -u
action="${1:-session}"
[ "$action" = "session" ] || exit 0
payload="$(cat)"
conversation_id="$(printf '%s' "$payload" | sed -n 's/.*"conversation_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
agent_id="$(printf '%s' "$payload" | sed -n 's/.*"agent_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
if [ "$conversation_id" = "default" ]; then
  [ -n "$agent_id" ] || exit 0
  session_id="default:$agent_id"
else
  session_id="$conversation_id"
fi
if printf '%s' "$payload" | grep -q '"is_new_session"[[:space:]]*:[[:space:]]*true'; then
  session_start_source="new"
else
  session_start_source="resume"
fi
[ -n "$HERDR_DESKTOP_REPORT_URL" ] || exit 0
[ -n "$HERDR_DESKTOP_PANE_ID" ] || exit 0
[ -n "$session_id" ] || exit 0
body="{\"paneId\":\"$HERDR_DESKTOP_PANE_ID\",\"source\":\"herdr:letta\",\"agent\":\"letta\",\"sessionId\":\"$session_id\",\"sessionStartSource\":\"$session_start_source\"}"
curl -s -X POST "$HERDR_DESKTOP_REPORT_URL" -H 'Content-Type: application/json' --data "$body" >/dev/null 2>&1 || true
