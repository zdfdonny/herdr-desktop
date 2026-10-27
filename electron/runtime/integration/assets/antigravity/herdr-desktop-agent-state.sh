#!/usr/bin/env bash
# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=4
#
# antigravity（agy）非 Windows 版 hook：上报会话身份 + 状态。
# 逻辑与 .ps1 一致，改动原因见该文件顶部说明：
#   PreInvocation → working，Stop 且 fullyIdle=true → idle，
# 中间工具跑完不产生 idle 上报，从而不再误响完成提示音。
set -u
action="${1:-session}"
[ "$action" = "session" ] || [ "$action" = "stop" ] || exit 0
payload="$(cat)"
session_id="$(printf '%s' "$payload" | sed -n 's/.*"conversationId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
session_path="$(printf '%s' "$payload" | sed -n 's/.*"transcriptPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -n "${HERDR_DESKTOP_REPORT_URL:-}" ] || exit 0
[ -n "${HERDR_DESKTOP_PANE_ID:-}" ] || exit 0
[ -n "$session_id" ] || exit 0

# 毫秒时间戳作为单调 seq（hook 之间至少差几百毫秒）
seq="$(date +%s%3N 2>/dev/null || echo 0)"
case "$seq" in
  ''|*[!0-9]*) seq=0 ;;
esac

body="{\"paneId\":\"$HERDR_DESKTOP_PANE_ID\",\"source\":\"herdr:antigravity\",\"agent\":\"antigravity\",\"sessionId\":\"$session_id\",\"seq\":$seq"
[ -n "$session_path" ] && body="$body,\"sessionPath\":\"$session_path\""

if [ "$action" = "stop" ]; then
  # 只有 fullyIdle=true 的 Stop 才是真正完成；其余情况什么都不报——
  # 权限提示会与 Stop 同时到来（fullyIdle=false），此时报 working 会把屏幕
  # 刚检测到的 blocked 踩掉，导致提示音隔一次才响一次。
  printf '%s' "$payload" | grep -q '"fullyIdle"[[:space:]]*:[[:space:]]*true' || exit 0
  reason="$(printf '%s' "$payload" | sed -n 's/.*"terminationReason"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  error_text="$(printf '%s' "$payload" | sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
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
