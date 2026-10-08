/**
 * maki manifest —— 对应 herdr `src/detect/manifests/maki.toml`。
 */

import type { AgentManifest } from '../engine';

export const makiManifest: AgentManifest = {
  id: 'maki',
  rules: [
    {
      id: 'permission_prompt',
      state: 'blocked',
      priority: 980,
      region: 'whole_recent',
      visibleBlocker: true,
      contains: ['permission required'],
      any: [
        { contains: ['y allow', 'n deny'] },
        { contains: ['confirm allow'] },
        { contains: ['confirm deny'] },
        { contains: ['enter deny', 'esc cancel'] },
      ],
    },
    {
      id: 'plan_complete_form',
      state: 'blocked',
      priority: 970,
      region: 'whole_recent',
      visibleBlocker: true,
      contains: ['plan complete', 'enter confirm'],
      any: [{ contains: ['space toggle parallel'] }, { contains: ['edit plan'] }],
    },
    {
      id: 'status_bar_spinner_working',
      state: 'working',
      priority: 900,
      region: 'bottom_non_empty_lines(1)',
      visibleWorking: true,
      lineRegex: [String.raw`^( [\u2800-\u28ff]){1,2} \[(BUILD|PLAN|BASH)\]`],
    },
    {
      id: 'status_bar_idle',
      state: 'idle',
      priority: 850,
      region: 'bottom_non_empty_lines(1)',
      visibleIdle: true,
      lineRegex: [String.raw`^ \[(BUILD|PLAN|BASH)\]`],
    },
    {
      id: 'prompt_box_idle',
      state: 'idle',
      priority: 840,
      region: 'bottom_non_empty_lines(3)',
      visibleIdle: true,
      lineRegex: [String.raw`^\u276f `],
      not: [{ contains: ['queue another prompt'] }, { lineRegex: [String.raw`^( [\u2800-\u28ff]){1,2} `] }],
    },
  ],
};
