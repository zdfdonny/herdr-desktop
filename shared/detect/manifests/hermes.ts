/**
 * hermes manifest —— 对应 herdr `src/detect/manifests/hermes.toml`。
 */

import type { AgentManifest } from '../engine';

export const hermesManifest: AgentManifest = {
  id: 'hermes',
  rules: [
    {
      id: 'osc_title_blocked',
      state: 'blocked',
      priority: 1100,
      region: 'osc_title',
      visibleBlocker: true,
      regex: [String.raw`^\u26a0[\ufe0e\ufe0f]?(?:\s|$)`],
    },
    {
      id: 'osc_title_working',
      state: 'working',
      priority: 1050,
      region: 'osc_title',
      visibleWorking: true,
      regex: [String.raw`^\u23f3[\ufe0e\ufe0f]?(?:\s|$)`],
    },
    {
      id: 'dangerous_command_approval',
      state: 'blocked',
      priority: 900,
      region: 'bottom_non_empty_lines(14)',
      visibleBlocker: true,
      any: [
        { contains: ['dangerous'] },
        { contains: ['approval'] },
        { contains: ['allow once', 'deny'] },
        { lineRegex: [String.raw`(?i)^\s*[\u25b8>]?\s*1\.\s*allow`] },
      ],
      all: [
        {
          any: [{ contains: ['enter confirm'] }, { contains: ['enter to confirm'] }, { contains: ['↑/↓ to select'] }, { contains: ['show full command'] }],
        },
      ],
    },
    {
      id: 'clarification_prompt',
      state: 'blocked',
      priority: 900,
      region: 'bottom_non_empty_lines(14)',
      visibleBlocker: true,
      any: [
        { contains: ['hermes needs your'] },
        { lineRegex: [String.raw`^\s*ask\s+\S`] },
        { contains: ['type your answer'] },
      ],
      all: [
        {
          any: [{ contains: ['enter confirm'] }, { contains: ['enter to confirm'] }, { contains: ['enter send'] }, { contains: ['press enter'] }, { contains: ['↑/↓ select'] }, { contains: ['↑/↓ to select'] }, { contains: ['other (type'] }],
        },
      ],
    },
    {
      id: 'credential_prompt',
      state: 'blocked',
      priority: 900,
      region: 'bottom_non_empty_lines(14)',
      visibleBlocker: true,
      any: [
        { contains: ['sudo password'] },
        { contains: ['skill setup'] },
        { contains: ['🔑', 'for '] },
      ],
    },
    {
      id: 'confirmation_prompt',
      state: 'blocked',
      priority: 900,
      region: 'bottom_non_empty_lines(14)',
      visibleBlocker: true,
      all: [
        {
          any: [{ contains: ['approve once', 'cancel'] }, { contains: ['start a new session', 'keep going'] }],
        },
        {
          any: [{ contains: ['enter to confirm'] }, { contains: ['enter confirm'] }, { contains: ['type 1/2/3'] }, { contains: ['y/n quick'] }],
        },
      ],
    },
    {
      id: 'interrupt_status_working',
      state: 'working',
      priority: 950,
      region: 'bottom_non_empty_lines(5)',
      visibleWorking: true,
      any: [{ contains: ['msg=interrupt'] }, { contains: ['ctrl+c to interrupt'] }],
    },
    {
      id: 'classic_cancel_working',
      state: 'working',
      priority: 500,
      region: 'bottom_non_empty_lines(5)',
      visibleWorking: true,
      contains: ['ctrl+c cancel'],
    },
    {
      id: 'osc_title_idle',
      state: 'idle',
      priority: 100,
      region: 'osc_title',
      visibleIdle: true,
      regex: [String.raw`^\u2713[\ufe0e\ufe0f]?(?:\s|$)`],
    },
  ],
};
