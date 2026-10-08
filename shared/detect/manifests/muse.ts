/**
 * muse manifest —— 对应 herdr `src/detect/manifests/muse.toml`。
 */

import type { AgentManifest } from '../engine';

export const museManifest: AgentManifest = {
  id: 'muse',
  rules: [
    {
      id: 'workspace_trust_blocked',
      state: 'blocked',
      priority: 970,
      region: 'bottom_non_empty_lines(12)',
      visibleBlocker: true,
      contains: ['Do you trust this workspace?'],
      any: [{ contains: ['Trust and continue'] }, { contains: ['Use Up/Down'] }],
    },
    {
      id: 'pick_request_blocked',
      state: 'blocked',
      priority: 950,
      region: 'bottom_non_empty_lines(8)',
      visibleBlocker: true,
      any: [
        { contains: ['Enter to select', 'Tab for an optional note'] },
        { contains: ['Enter to toggle', 'Esc to interrupt'] },
      ],
    },
    {
      id: 'menu_overlay',
      state: 'unknown',
      priority: 940,
      region: 'bottom_non_empty_lines(8)',
      skipStateUpdate: true,
      any: [
        { contains: ['enter confirm', 'esc go back'] },
        { contains: ['enter save', 'esc go back'] },
        { contains: ['space toggle', 'esc close', 'type filter'] },
      ],
    },
    {
      id: 'working_esc_interrupt',
      state: 'working',
      priority: 900,
      region: 'bottom_non_empty_lines(8)',
      visibleWorking: true,
      contains: ['esc to interrupt'],
      not: [
        { contains: ['Enter to select', 'Tab for an optional note'] },
        { contains: ['Enter to toggle', 'Esc to interrupt'] },
      ],
    },
    {
      id: 'blocked_approval',
      state: 'blocked',
      priority: 850,
      region: 'bottom_non_empty_lines(8)',
      visibleBlocker: true,
      any: [
        { contains: ['Allow this stage once', 'Always allow in this workspace'] },
        { contains: ['Allow once', 'Allow for this session'] },
        { contains: ['Yes, proceed', "Yes, don't ask again this session"] },
      ],
    },
    {
      id: 'idle_prompt',
      state: 'idle',
      priority: 700,
      region: 'bottom_non_empty_lines(5)',
      visibleIdle: true,
      any: [{ lineRegex: [String.raw`^\s*\u27e9\s*$`] }, { lineRegex: [String.raw`^\s*\u27e9\s+\S`] }],
      not: [
        { contains: ['esc to interrupt'] },
        { contains: ['Enter to select', 'Tab for an optional note'] },
        { contains: ['Enter to toggle', 'Esc to interrupt'] },
        { contains: ['enter confirm', 'esc go back'] },
        { contains: ['enter save', 'esc go back'] },
        { contains: ['space toggle', 'esc close', 'type filter'] },
      ],
    },
    {
      id: 'idle_status_fallback',
      state: 'idle',
      priority: 500,
      region: 'bottom_non_empty_lines(3)',
      visibleIdle: true,
      lineRegex: [String.raw`^\s*\S+ \u00b7 (none|minimal|low|medium|high|xhigh|ultra) \u00b7 `],
      not: [{ contains: ['esc to interrupt'] }],
    },
  ],
};
