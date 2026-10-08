/**
 * devin manifest —— 对应 herdr `src/detect/manifests/devin.toml`。
 */

import type { AgentManifest } from '../engine';

export const devinManifest: AgentManifest = {
  id: 'devin',
  rules: [
    {
      id: 'workspace_trust_prompt',
      state: 'blocked',
      priority: 300,
      region: 'bottom_non_empty_lines(8)',
      visibleBlocker: true,
      contains: ['do you trust the authors of this directory?', 'with untrusted content.', 'yes, trust '],
    },
    {
      id: 'permission_prompt',
      state: 'blocked',
      priority: 290,
      region: 'bottom_non_empty_lines(8)',
      visibleBlocker: true,
      contains: ['approve once', 'select', 'confirm', 'esc cancel'],
    },
    {
      id: 'running_tools_footer',
      state: 'working',
      priority: 200,
      region: 'bottom_non_empty_lines(8)',
      visibleWorking: true,
      contains: ['running tools', 'esc to interrupt'],
      not: [{ contains: ['approve once', 'esc cancel'] }],
    },
    {
      id: 'guide_while_working',
      state: 'working',
      priority: 190,
      region: 'bottom_non_empty_lines(6)',
      visibleWorking: true,
      contains: ['guide devin while it works'],
      not: [{ contains: ['approve once', 'esc cancel'] }],
    },
    {
      id: 'tool_reading_timeout',
      state: 'working',
      priority: 180,
      region: 'bottom_non_empty_lines(8)',
      visibleWorking: true,
      contains: ['reading shell ', 'timeout:'],
      not: [{ contains: ['approve once', 'esc cancel'] }],
    },
    {
      id: 'welcome_prompt_footer',
      state: 'idle',
      priority: 120,
      region: 'bottom_non_empty_lines(8)',
      visibleIdle: true,
      contains: ['ask devin to build', 'features, fix bugs', 'your code'],
      lineRegex: [String.raw`^\s*\u276d Ask Devin to build`],
      not: [
        { contains: ['approve once', 'esc cancel'] },
        { contains: ['running tools', 'esc to interrupt'] },
        { contains: ['guide devin while it works'] },
      ],
    },
    {
      id: 'live_prompt_footer',
      state: 'idle',
      priority: 100,
      region: 'bottom_non_empty_lines(6)',
      visibleIdle: true,
      contains: ['context:'],
      lineRegex: [String.raw`^\s*\u276d`],
      not: [
        { contains: ['approve once', 'esc cancel'] },
        { contains: ['running tools', 'esc to interrupt'] },
        { contains: ['guide devin while it works'] },
      ],
    },
  ],
};
