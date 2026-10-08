/**
 * amp manifest —— 对应 herdr `src/detect/manifests/amp.toml`。
 */

import type { AgentManifest } from '../engine';

export const ampManifest: AgentManifest = {
  id: 'amp',
  rules: [
    {
      id: 'osc_title_plugin_confirmation_blocked',
      state: 'blocked',
      priority: 1100,
      region: 'osc_title',
      visibleBlocker: true,
      contains: ['Plugin confirmation needed'],
    },
    {
      id: 'osc_title_working',
      state: 'working',
      priority: 1050,
      region: 'osc_title',
      visibleWorking: true,
      regex: [String.raw`^[\u2800-\u28ff] `],
    },
    {
      id: 'approval_footer',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      visibleBlocker: true,
      any: [
        { contains: ['waiting for approval'] },
        { contains: ['invoke tool'] },
        { contains: ['run this command?'] },
        { contains: ['allow editing file:'] },
        { contains: ['allow creating file:'] },
        { contains: ['confirm tool call'] },
        {
          contains: ['approve'],
          any: [{ contains: ['allow all for this session'] }, { contains: ['allow all for every session'] }, { contains: ['allow file for every session'] }, { contains: ['deny with feedback'] }],
        },
      ],
    },
    {
      id: 'status_footer_working',
      state: 'working',
      priority: 200,
      region: 'bottom_non_empty_lines(5)',
      visibleWorking: true,
      lineRegex: [String.raw`(?i)^\s*\u2570\s+\S+\s+(thinking|streaming|running tools|waiting)\s+\u2500`],
    },
    {
      id: 'esc_cancel_working',
      state: 'working',
      priority: 100,
      region: 'whole_recent',
      visibleWorking: true,
      contains: ['esc to cancel'],
    },
    {
      id: 'osc_title_idle',
      state: 'idle',
      priority: 50,
      region: 'osc_title',
      visibleIdle: true,
      contains: [' - amp - '],
      not: [{ regex: [String.raw`^[\u2800-\u28ff] `] }, { contains: ['Plugin confirmation needed'] }],
    },
  ],
};
