#!/usr/bin/env bash
# HERDR_DESKTOP_INTEGRATION_ID=herdr-desktop
# HERDR_DESKTOP_INTEGRATION_VERSION=5
#
# claude hook: report session identity + agent state (same logic as the .ps1
# asset; that file carries the mirrored English rationale).
#
# Why report state from hooks: the screen only shows "the spinner stopped" and
# cannot tell "the model is still thinking" from "the turn really ended", so a
# finished tool counts as a completion too. Hooks bracket the turn exactly:
#   SessionStart     -> session (bind session id / transcript)
#   UserPromptSubmit -> working (turn start: the only idle -> working edge)
#   PostToolUse      -> tick (heartbeat: refresh working, never revive idle)
#   Stop             -> idle (the only real completion point)
#   StopFailure      -> idle + completion=aborted (no finish sound)
#
# The tick/heartbeat split matters because these two hooks run async while Stop
# is synchronous: a late heartbeat must not flip a finished pane back to working
# (that loses the finish sound and projects a second "done" badge). See
# TerminalState.isStaleHeartbeat.
#
# blocked is deliberately NOT reported: Claude Code has no "permission granted"
# event, so a blocked report from PermissionRequest would stick until
# PostToolUse fires - i.e. the pane would keep showing "waiting for input" for
# the whole time an approved command runs. Permission dialogs stay on screen
# detection (the claude manifest has solid rules for the bash prompt), which
# reacts the moment the dialog appears or disappears.
#
# A user interrupt (Esc) fires no Stop at all, so the last working report would
# sit on the pane; the main process expires working reports from non-full-
# lifecycle sources after a 1.5s TTL (HOOK_WORKING_TTL_MS in terminal-state.ts)
# and hands the decision back to the screen, so nothing extra is needed here.
set -u
action="${1:-session}"
case "$action" in session|working|tick|idle|failed) ;; *) exit 0 ;; esac
payload="$(cat)"
# Only judge from the PREFIX of the payload. The common fields (session_id,
# hook_event_name, agent_id, ...) come first; the event-specific free-form
# payloads (tool_input, tool_response, prompt, last_assistant_message) follow,
# and nested objects inside those can carry the SAME key names - e.g. a Write
# tool writing JSON that contains agent_id, or writing a hooks config that
# contains hook_event_name. Matching the whole payload drops real reports in
# those cases (measured). Text inside string values is not a concern: JSON
# escapes its quotes as \" so a bare-quote pattern cannot match it.
# Stacking several s commands cuts at the earliest of those keys (each one only
# trims a tail, so the result converges).
# This assumes the common fields (agent_id included) precede the event-specific
# ones; if upstream ever reorders them, the subagent filter degrades to not
# filtering (one extra status report, never a stuck state).
scan="$(printf '%s' "$payload" |
  sed -e 's/"tool_input".*//' -e 's/"tool_response".*//' \
      -e 's/"prompt".*//' -e 's/"last_assistant_message".*//')"
# Take the FIRST value of a key: a greedy 's/.*"key":.../' would take the last
# one, letting a same-named key inside a nested object shadow the real common
# field.
field() {
  printf '%s' "$scan" |
    grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" |
    head -n1 |
    sed 's/^"[^"]*"[[:space:]]*:[[:space:]]*"//; s/"$//'
}
# filter cursor events
if [ -n "${CURSOR_VERSION:-}" ] || printf '%s' "$scan" | grep -q '"cursor_version"'; then exit 0; fi
# filter subagent events: hooks fire inside subagents too and carry agent_id;
# without this a subagent's Stop would read as "main task finished".
if printf '%s' "$scan" | grep -q '"agent_id"[[:space:]]*:[[:space:]]*"[^"]'; then exit 0; fi
hook_event="$(field hook_event_name)"
case "$action" in
  session) expected='SessionStart' ;;
  working) expected='UserPromptSubmit' ;;
  tick) expected='PostToolUse' ;;
  idle) expected='Stop' ;;
  failed) expected='StopFailure' ;;
esac
# One action may be registered on several events; drop anything that drifts
# so a mixed-up config can never cross states.
if [ -n "$hook_event" ] && ! printf '%s' "$hook_event" | grep -Eq "^($expected)$"; then exit 0; fi
session_id="$(field session_id)"
[ -n "${HERDR_DESKTOP_REPORT_URL:-}" ] || exit 0
[ -n "${HERDR_DESKTOP_PANE_ID:-}" ] || exit 0
[ -n "$session_id" ] || exit 0
# No seq: there is no portable millisecond timestamp here (BSD date on macOS has
# no %3N), while the main process requires seq to increase strictly - a constant
# value would drop every report after the first (observable as "no completion
# sound"). When seq is absent the main process supplies one
# (see router.reportAgentSession).
body="{\"paneId\":\"$HERDR_DESKTOP_PANE_ID\",\"source\":\"herdr-desktop:claude\",\"agent\":\"claude\",\"sessionId\":\"$session_id\""
case "$action" in
  session)
    session_path="$(field transcript_path)"
    session_start_source="$(field source)"
    [ -n "$session_path" ] && body="$body,\"sessionPath\":\"$session_path\""
    [ -n "$session_start_source" ] && body="$body,\"sessionStartSource\":\"$session_start_source\""
    ;;
  working) body="$body,\"state\":\"working\"" ;;
  tick) body="$body,\"state\":\"working\",\"heartbeat\":true" ;;
  idle) body="$body,\"state\":\"idle\"" ;;
  failed) body="$body,\"state\":\"idle\",\"completion\":\"aborted\"" ;;
esac
body="$body}"
curl -s -X POST "$HERDR_DESKTOP_REPORT_URL" -H 'Content-Type: application/json' --data "$body" >/dev/null 2>&1 || true
