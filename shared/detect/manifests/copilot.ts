/**
 * copilot manifest —— 对应 herdr `src/detect/manifests/github-copilot.toml`。
 */

import type { AgentManifest } from '../engine';

export const copilotManifest: AgentManifest = {
  id: 'copilot',
  rules: [
    {
      id: 'selection_blocker',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      visibleBlocker: true,
      all: [
        { any: [{ contains: ['esc to cancel'] }, { contains: ['esc cancel'] }] },
        { any: [{ contains: ['enter to select'] }, { contains: ['enter to confirm'] }, { contains: ['enter to submit'] }, { contains: ['enter accept'] }] },
      ],
    },
    {
      id: 'background_agents_working',
      state: 'working',
      priority: 110,
      region: 'bottom_non_empty_lines(6)',
      visibleWorking: true,
      lineRegex: [String.raw`^\s*\u25ce\s+Waiting for background agents(?:\s|\u00b7|$)`],
    },
    {
      id: 'working_cancel_hint',
      state: 'working',
      priority: 100,
      region: 'whole_recent',
      visibleWorking: true,
      any: [
        { contains: ['esc to cancel'] },
        { contains: ['esc cancel'] },
        { contains: ['esc again to cancel'] },
        { contains: ['esc interrupt'] },
      ],
    },
  ],
};
