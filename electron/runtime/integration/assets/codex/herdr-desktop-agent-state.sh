#!/usr/bin/env bash
# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=3
set -u
action="${1:-session}"
case "$action" in session|working|idle) ;; *) exit 0 ;; esac
payload="$(cat)"
hook_event="$(printf '%s' "$payload" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
case "$action" in
  session) expected="SessionStart" ;;
  working) expected="UserPromptSubmit" ;;
  idle) expected="Stop|Interrupt" ;;
esac
if [ -n "$hook_event" ] && ! printf '%s' "$hook_event" | grep -Eq "^($expected)$"; then exit 0; fi
session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
# CODEX_THREAD_ID inherited-session check
if [ -n "${CODEX_THREAD_ID:-}" ] && [ -n "$session_id" ] && [ "$CODEX_THREAD_ID" != "$session_id" ]; then exit 0; fi
session_start_source=""
if [ "$action" = "session" ]; then
  transcript_path="$(printf '%s' "$payload" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  [ -n "$transcript_path" ] || exit 0
  session_start_source="$(printf '%s' "$payload" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
fi
[ -n "$HERDR_DESKTOP_REPORT_URL" ] || exit 0
[ -n "$HERDR_DESKTOP_PANE_ID" ] || exit 0
[ -n "$session_id" ] || exit 0
body="{\"paneId\":\"$HERDR_DESKTOP_PANE_ID\",\"source\":\"herdr:codex\",\"agent\":\"codex\""
[ -n "$session_id" ] && body="$body,\"sessionId\":\"$session_id\""
[ -n "$session_start_source" ] && body="$body,\"sessionStartSource\":\"$session_start_source\""
case "$action" in working|blocked|idle|done) body="$body,\"state\":\"$action\"";; esac
body="$body}"
curl -s -X POST "$HERDR_DESKTOP_REPORT_URL" -H 'Content-Type: application/json' --data "$body" >/dev/null 2>&1 || true
