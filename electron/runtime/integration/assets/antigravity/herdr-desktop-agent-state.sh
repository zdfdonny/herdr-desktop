#!/usr/bin/env bash
# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=2
set -u
action="${1:-session}"
payload="$(cat)"
session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -z "$session_id" ] && session_id="$(printf '%s' "$payload" | sed -n 's/.*"sessionId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
# SessionStart(source=startup) 是全新会话，可能尚无对话内容，空会话无法 --resume；先不保存，等首个内容事件再报。
session_source="$(printf '%s' "$payload" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
if [ "$action" = "session" ] && [ "$session_source" = "startup" ]; then
  session_id=""
fi
[ -z "$HERDR_DESKTOP_REPORT_URL" ] && exit 0
[ -z "$HERDR_DESKTOP_PANE_ID" ] && exit 0
agent="${HERDR_DESKTOP_AGENT:-unknown}"
body="{\"paneId\":\"$HERDR_DESKTOP_PANE_ID\",\"source\":\"herdr:$agent\",\"agent\":\"$agent\""
[ -n "$session_id" ] && body="$body,\"sessionId\":\"$session_id\""
case "$action" in working|blocked|idle|done) body="$body,\"state\":\"$action\"";; esac
body="$body}"
curl -s -X POST "$HERDR_DESKTOP_REPORT_URL" -H 'Content-Type: application/json' --data "$body" >/dev/null 2>&1 || true
