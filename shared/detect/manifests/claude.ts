/**
 * claude manifest —— 对应 herdr `distribution/agent-detection/claude.toml`（version 2026.10.11.1）。
 *
 * claude 是 session-only（hook 只报会话），状态来自屏幕 + OSC 标题/进度。
 * 最可靠的信号是 OSC：标题以 braille/半圆 spinner 开头 → working（priority 1100，
 * 最高）；标题 "✳ " 或进度 "4;0" → idle（250，最低）。屏幕规则在中间。
 *
 * 带 `skipStateUpdate` 的规则（transcript_viewer / model_picker_menu）对应 herdr 的
 * `skip_state_update`：命中时整条检测结果作废、状态保持原样。这类浮层/菜单打开时
 * 屏幕上已经没有 spinner 与 prompt box 特征，若照常判定就会产生一次假的
 * working → idle 完成跳变。
 */

import type { AgentManifest } from '../engine';

export const claudeManifest: AgentManifest = {
  id: 'claude',
  rules: [
    {
      id: 'osc_title_working',
      state: 'working',
      priority: 1100,
      region: 'osc_title',
      visibleWorking: true,
      // Braille 覆盖 <= 2.1.227；半圆（◐-◓）是 2.1.228 起的忙时 spinner。
      regex: [String.raw`^[\u2800-\u28ff\u25d0-\u25d3] `],
    },
    {
      id: 'transcript_viewer',
      state: 'unknown',
      priority: 1000,
      region: 'bottom_non_empty_lines(3)',
      skipStateUpdate: true,
      contains: ['showing detailed transcript'],
      any: [
        { contains: ['ctrl+o', 'to toggle'] },
        { contains: ['ctrl+e', 'show all'] },
        { contains: ['ctrl+e', 'collapse'] },
        { contains: ['↑↓ scroll'] },
        { contains: ['? for shortcuts'] },
      ],
    },
    {
      id: 'live_blocked_form',
      state: 'blocked',
      priority: 980,
      region: 'after_last_horizontal_rule',
      visibleBlocker: true,
      contains: ['esc to cancel'],
      any: [
        { contains: ['enter to confirm'] },
        {
          contains: ['enter to select'],
          any: [
            { contains: ['tab/arrow keys to navigate'] },
            { contains: ['arrow keys to navigate'] },
            { contains: ['arrows to navigate'] },
            { contains: ['↑/↓ to navigate'] },
            { contains: ['↑↓ to navigate'] },
          ],
        },
      ],
    },
    {
      id: 'live_blocked_form_named_session',
      state: 'blocked',
      priority: 980,
      region: 'whole_recent',
      visibleBlocker: true,
      // 每个控件都绑定到同一行 footer，允许词间换行；名字分隔线之后只接受
      // 「计数型任务面板 + 带标记的行 + 可选的 pending 溢出」，自由格式的活动文本
      // 不算（对应 herdr 上游注释 #4573）。
      // 注：herdr 用 Rust 的 `\z`（绝对结尾），JS 里等价写法不存在，这里用 `$` 近似。
      regex: [
        String.raw`(?i)(?:^|\n)[ \t]*enter\s+to\s+(?:confirm|select\s+·\s+(?:(?:tab/arrow|arrow)\s+keys|arrows|↑/↓|↑↓)\s+to\s+navigate)\s+·\s+esc\s+to\s+cancel[ \t]*\n(?:[ \t]*\n)*[ \t]*─{3,}[^\n]*(?:\n(?:[ \t]*\n)*[ \t]+\d+ tasks? \(\d+ done, (?:\d+ in progress, )?\d+ open\)(?:\n[ \t]+[◻◼✔][ \t]+[^\n]+)+(?:\n[ \t]+…[ \t]+\+\d+[ \t]+pending)?)?(?:\n[ \t]*)*$`,
      ],
    },
    {
      id: 'dynamic_workflow_prompt',
      state: 'blocked',
      priority: 980,
      region: 'whole_recent',
      visibleBlocker: true,
      contains: ['run a dynamic workflow?', 'esc to cancel'],
    },
    {
      id: 'mcp_elicitation_prompt',
      state: 'blocked',
      priority: 980,
      region: 'whole_recent',
      visibleBlocker: true,
      // MCP elicitation 对话框（elicitation/create）只有 Esc to cancel、没有 Enter 提示，
      // live_blocked_form 看不见它（herdr 上游 #3283）。
      contains: ['esc to cancel'],
      lineRegex: [String.raw`(?i)^\s*MCP server ["\u201C].+["\u201D] requests your input\s*$`],
      all: [
        {
          any: [
            { lineRegex: [String.raw`^\s*\u276F?\s*Accept\b`] },
            { lineRegex: [String.raw`^\s*\u276F?\s*Decline\b`] },
          ],
        },
      ],
    },
    {
      id: 'btw_overlay_working',
      state: 'working',
      priority: 975,
      region: 'bottom_non_empty_lines(5)',
      visibleWorking: true,
      // `/btw` 浮层：输入行以 /btw 开头，底部提示 esc to close。
      lineRegex: [String.raw`^\s*/btw(?:\s|$)`, String.raw`(?i)esc to close\s*$`],
    },
    {
      id: 'live_turn_working',
      state: 'working',
      priority: 970,
      region: 'bottom_non_empty_lines(12)',
      visibleWorking: true,
      any: [
        { lineRegex: [String.raw`^\s*[\u23f8\u23f5].*esc to interrupt(?:\s|\u00b7|$)`] },
        {
          lineRegex: [
            String.raw`^\s*[\u002a\u00b7\u2722\u2733\u2736\u273b\u273d]\s+\S.*\u2026(?:\s+\(\d+[smh](?:\s|\u00b7)|\s*$)`,
          ],
        },
      ],
    },
    {
      id: 'background_agents_working',
      state: 'working',
      priority: 965,
      region: 'last_non_empty_above_prompt_box',
      visibleWorking: true,
      // 刻意不含 ✳（U+2733）——它是 idle 标题字符，放进来会让用户输入误命中。
      lineRegex: [
        String.raw`^\s*[\u002a\u00b7\u2722\u2736\u273b\u273d]\s+Waiting for [1-9]\d* background agents? to finish\s*$`,
      ],
    },
    {
      id: 'background_mcp_task_working',
      state: 'working',
      priority: 965,
      region: 'bottom_non_empty_lines(12)',
      visibleWorking: true,
      // claude 把活动摘要渲染在第 0 列，换行续行带缩进；保持这个形状可以避免
      // 用户输入的文本冒充该信号。
      regex: [
        String.raw`(?m)^[\u002a\u00b7\u2722\u2736\u273b\u273d][ \t]+\S[^\n]*?(?:\n[ \t]+[^\n]*?){0,3}\u00b7(?:[ \t]+|\n[ \t]*)[1-9]\d*(?:[ \t]+|\n[ \t]*)MCP(?:[ \t]+|\n[ \t]*)tasks?(?:[ \t]+|\n[ \t]*)still(?:[ \t]+|\n[ \t]*)running[ \t]*$`,
      ],
      not: [
        { contains: ['do you want to proceed?'] },
        { contains: ['esc to cancel'] },
        { contains: ['waiting for permission'] },
        { contains: ['do you want to allow this connection?'] },
        { contains: ['tab to amend'] },
        { contains: ['ctrl+e to explain'] },
      ],
    },
    {
      id: 'live_prompt_box',
      state: 'idle',
      priority: 950,
      region: 'prompt_box_body',
      visibleIdle: true,
      lineRegex: [String.raw`^\s*\u276f`],
      not: [
        { contains: ['enter to select'] },
        { contains: ['esc to cancel'] },
        { contains: ['tab/arrow keys'] },
        { contains: ['arrow keys to navigate'] },
        { contains: ['↑/↓ to navigate'] },
      ],
    },
    {
      id: 'model_picker_menu',
      state: 'unknown',
      priority: 900,
      region: 'whole_recent',
      skipStateUpdate: true,
      contains: ['select model', 'enter to set as default', 'esc to cancel'],
      not: [
        { contains: ['do you want to proceed?'] },
        { contains: ['enter to select'] },
      ],
    },
    {
      id: 'bash_permission_prompt',
      state: 'blocked',
      priority: 850,
      region: 'whole_recent',
      visibleBlocker: true,
      contains: ['do you want to proceed?'],
      any: [
        { contains: ['bash command'] },
        { contains: ['bash('] },
        { contains: ['contains expansion'] },
        { contains: ['tab to amend'] },
        { contains: ['ctrl+e to explain'] },
      ],
      /*
       * claude 用 "❯" 标记当前选中项，所以每个选项分支都要允许该前缀；
       * 不带前缀的分支只能匹配光标移开的选项，静止布局会漏（herdr 上游 #2650）：
       *   ❯ 1. Yes / 2. Yes, and don't ask again for: <cmd> / 3. No
       * 两选项与「don't ask again」的三选项形状都要覆盖，让本规则而不是更窄的
       * generic_permission_prompt 认领 Bash 审批。
       */
      all: [
        {
          any: [
            { lineRegex: [String.raw`(?i)^\s*\u276F?\s*yes\b`] },
            { lineRegex: [String.raw`(?i)^\s*\u276F?\s*1\.\s*yes\b`] },
            { lineRegex: [String.raw`(?i)^\s*\u276F?\s*2\.\s*yes\b`] },
            { lineRegex: [String.raw`(?i)^\s*\u276F?\s*2\.\s*no\b`] },
            { lineRegex: [String.raw`(?i)^\s*\u276F?\s*3\.\s*no\b`] },
          ],
        },
      ],
    },
    {
      id: 'generic_permission_prompt',
      state: 'blocked',
      priority: 840,
      region: 'after_last_horizontal_rule',
      visibleBlocker: true,
      contains: ['do you want to proceed?', 'esc to cancel'],
      all: [
        {
          any: [
            { lineRegex: [String.raw`(?i)^\s*\u276F?\s*1\.\s*yes\b`] },
            { lineRegex: [String.raw`(?i)^\s*\u276F?\s*2\.\s*yes\b`] },
            { lineRegex: [String.raw`(?i)^\s*\u276F?\s*2\.\s*no\b`] },
            { lineRegex: [String.raw`(?i)^\s*\u276F?\s*3\.\s*no\b`] },
          ],
        },
      ],
    },
    {
      id: 'legacy_no_prompt_blocker',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      any: [
        { contains: ['do you want to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
        { contains: ['would you like to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
        { contains: ['waiting for permission'] },
        { contains: ['do you want to allow this connection?'] },
        { contains: ['tab to amend'] },
        { contains: ['ctrl+e to explain'] },
        { contains: ['do you want to proceed?', 'esc to cancel'] },
        { contains: ['review your answers'] },
        { contains: ['skip interview and plan immediately'] },
      ],
      not: [{ regex: [String.raw`(?m)^\s*\u276f\s*$`] }],
    },
    {
      id: 'osc_title_idle',
      state: 'idle',
      priority: 250,
      region: 'osc_title',
      visibleIdle: true,
      regex: [String.raw`^\u2733 `],
    },
    {
      id: 'osc_progress_idle',
      state: 'idle',
      priority: 250,
      region: 'osc_progress',
      regex: ['^4;0'],
    },
  ],
};
