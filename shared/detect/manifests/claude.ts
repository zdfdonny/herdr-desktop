/**
 * claude manifest —— 对应 herdr `src/detect/manifests/claude.toml`。
 *
 * claude 是 session-only（hook 只报会话），状态来自屏幕 + OSC 标题/进度。
 * 最可靠的信号是 OSC：标题以 braille/半圆 spinner 开头 → working（priority 1100，
 * 最高）；标题 "✳ " 或进度 "4;0" → idle（250，最低）。屏幕规则在中间。
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
      regex: [String.raw`^[\u2800-\u28ff\u25d0-\u25d3] `],
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
      lineRegex: [
        String.raw`^\s*[\u002a\u00b7\u2722\u2733\u2736\u273b\u273d]\s+Waiting for [1-9]\d* background agents? to finish\s*$`,
      ],
    },
    {
      id: 'background_mcp_task_working',
      state: 'working',
      priority: 965,
      region: 'bottom_non_empty_lines(12)',
      visibleWorking: true,
      regex: [
        String.raw`(?m)^[\u002a\u00b7\u2722\u2733\u2736\u273b\u273d][ \t]+\S[^\n]*?(?:\n[ \t]+[^\n]*?){0,3}\u00b7(?:[ \t]+|\n[ \t]*)[1-9]\d*(?:[ \t]+|\n[ \t]*)MCP(?:[ \t]+|\n[ \t]*)tasks?(?:[ \t]+|\n[ \t]*)still(?:[ \t]+|\n[ \t]*)running[ \t]*$`,
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
    },
    {
      id: 'generic_permission_prompt',
      state: 'blocked',
      priority: 840,
      region: 'after_last_horizontal_rule',
      visibleBlocker: true,
      contains: ['do you want to proceed?', 'esc to cancel'],
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
      regex: [String.raw`^4;0`],
    },
  ],
};
