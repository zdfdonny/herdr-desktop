/**
 * cursor manifest —— 对应 herdr `src/detect/manifests/cursor.toml`。
 */

import type { AgentManifest } from '../engine';

export const cursorManifest: AgentManifest = {
  id: 'cursor',
  rules: [
    {
      id: 'write_file_approval',
      state: 'blocked',
      priority: 320,
      region: 'bottom_non_empty_lines(8)',
      visibleBlocker: true,
      contains: ['write to this file?', 'proceed (y)'],
      any: [
        { contains: ['reject & propose changes'] },
        { contains: ['esc or n or p'] },
        { contains: ['add write('] },
      ],
    },
    {
      id: 'approval_prompt',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      visibleBlocker: true,
      any: [
        {
          contains: ['waiting for approval', 'run this command?'],
          any: [{ contains: ['run (once) (y)'] }, { contains: ['skip (esc or n)'] }],
        },
        { contains: ['(y) (enter)'] },
        { lineRegex: [String.raw`(?i)^\s*allow .*\(y\)`] },
        { contains: ['keep (n)'] },
        { contains: ['skip (esc or n)'] },
        { lineRegex: [String.raw`(?i)^\s*(?:\u2192\s*)?run .*\(y\)`] },
      ],
    },
    {
      id: 'stop_hint_working',
      state: 'working',
      priority: 100,
      region: 'bottom_non_empty_lines(6)',
      visibleWorking: true,
      contains: ['ctrl+c to stop'],
    },
    {
      id: 'background_task_status_working',
      state: 'working',
      priority: 95,
      region: 'bottom_non_empty_lines(5)',
      visibleWorking: true,
      lineRegex: [String.raw`(?i)\b[1-9][0-9]*\s+background\s+tasks?\b`],
    },
    {
      id: 'spinner_working',
      state: 'working',
      priority: 90,
      region: 'bottom_non_empty_lines(8)',
      visibleWorking: true,
      lineRegex: [String.raw`^\s*(\u2b21|\u2b22|[\u2800-\u28ff]+)\s+\p{L}+\w*ing\b`],
    },
  ],
};
