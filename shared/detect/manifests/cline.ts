/**
 * cline manifest —— 对应 herdr `src/detect/manifests/cline.toml`。
 */

import type { AgentManifest } from '../engine';

export const clineManifest: AgentManifest = {
  id: 'cline',
  rules: [
    {
      id: 'tool_permission',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      visibleBlocker: true,
      any: [
        { contains: ['let cline use this tool'] },
        { contains: ['[act mode]', 'execute command?', 'yes'] },
        { contains: ['[act mode]', 'use this tool?', 'yes'] },
        { contains: ['[plan mode]', 'execute command?', 'yes'] },
        { contains: ['[plan mode]', 'use this tool?', 'yes'] },
      ],
    },
    {
      id: 'inline_tool_permission',
      state: 'blocked',
      priority: 300,
      region: 'bottom_non_empty_lines(16)',
      visibleBlocker: true,
      contains: ['Cline needs permission', 'Approve tool call?', '[y] Approve', '[n] Deny'],
    },
    {
      id: 'inline_question',
      state: 'blocked',
      priority: 300,
      region: 'bottom_non_empty_lines(24)',
      visibleBlocker: true,
      lineRegex: [String.raw`^\s*Cline is asking a question\s*$`, String.raw`^\s*>\s+\S`],
      contains: ['(Tab)', 'Shift+Tab'],
    },
    {
      id: 'active_turn',
      state: 'working',
      priority: 200,
      region: 'bottom_non_empty_lines(20)',
      visibleWorking: true,
      any: [{ lineRegex: [String.raw`^\s*[\u2801-\u28ff]\s+\S`] }, { contains: ['Thinking... (esc to cancel)'] }],
    },
    {
      id: 'composer_idle',
      state: 'idle',
      priority: 100,
      region: 'bottom_non_empty_lines(12)',
      visibleIdle: true,
      lineRegex: [String.raw`^\s*\u276f(?:\s.*)?$`],
      contains: ['─', '(Tab)', 'Shift+Tab'],
    },
    {
      id: 'default_cline_working',
      state: 'working',
      priority: -10,
      region: 'whole_recent',
      visibleWorking: true,
      regex: [String.raw`(?s).+`],
    },
  ],
};
