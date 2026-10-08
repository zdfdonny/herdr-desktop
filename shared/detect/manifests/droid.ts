/**
 * droid manifest —— 对应 herdr `src/detect/manifests/droid.toml`。
 */

import type { AgentManifest } from '../engine';

export const droidManifest: AgentManifest = {
  id: 'droid',
  rules: [
    {
      id: 'execute_selection_blocker',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      visibleBlocker: true,
      contains: ['enter to select', 'esc to cancel'],
      any: [{ contains: ['↑↓ to navigate'] }, { contains: ['use ↑↓ to navigate'] }],
      all: [{ any: [{ contains: ['> yes, allow'] }, { contains: ['> no, cancel'] }] }],
    },
    {
      id: 'selection_menu_blocker',
      state: 'blocked',
      priority: 290,
      region: 'bottom_non_empty_lines(8)',
      visibleBlocker: true,
      contains: ['enter select', 'esc cancel'],
      any: [{ contains: ['↑/↓ navigate'] }, { contains: ['↑↓ navigate'] }],
    },
    {
      id: 'spinner_stop_working',
      state: 'working',
      priority: 110,
      region: 'whole_recent',
      visibleWorking: true,
      contains: ['esc to stop'],
      lineRegex: [String.raw`^\s*[\u2800-\u28ff]`],
    },
    {
      id: 'stop_hint_working',
      state: 'working',
      priority: 100,
      region: 'whole_recent',
      visibleWorking: true,
      contains: ['esc to stop'],
    },
  ],
};
