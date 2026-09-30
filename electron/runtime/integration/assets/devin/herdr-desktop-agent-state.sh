#!/usr/bin/env bash
# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=3
set -u
action="${1:-session}"
[ "$action" = "session" ] || exit 0
payload="$(cat)"
session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -z "$session_id" ] && session_id="$(printf '%s' "$payload" | sed -n 's/.*"sessionId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
# devin list fallback: match working_directory
if [ -z "$session_id" ]; then
  project_dir="${DEVIN_PROJECT_DIR:-$(pwd)}"
  list_json="$(devin list --format json 2>/dev/null || true)"
  if [ -n "$list_json" ]; then
    escaped="$(printf '%s' "$project_dir" | sed 's/[][\.*^$\\/]/\\&/g')"
    session_id="$(printf '%s' "$list_json" | sed -n "s/.*\"working_directory\"[[:space:]]*:[[:space:]]*\"$escaped\"[^}]*\"id\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1)"
    [ -z "$session_id" ] && session_id="$(printf '%s' "$list_json" | sed -n "s/.*\"id\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\"[^}]*\"working_directory\"[[:space:]]*:[[:space:]]*\"$escaped\".*/\1/p" | head -n1)"
  fi
fi
[ -n "$HERDR_DESKTOP_REPORT_URL" ] || exit 0
[ -n "$HERDR_DESKTOP_PANE_ID" ] || exit 0
[ -n "$session_id" ] || exit 0
body="{\"paneId\":\"$HERDR_DESKTOP_PANE_ID\",\"source\":\"herdr:devin\",\"agent\":\"devin\""
[ -n "$session_id" ] && body="$body,\"sessionId\":\"$session_id\""
body="$body}"
curl -s -X POST "$HERDR_DESKTOP_REPORT_URL" -H 'Content-Type: application/json' --data "$body" >/dev/null 2>&1 || true
