/**
 * letta manifest —— 对应 herdr `src/detect/manifests/letta.toml`。
 */

import type { AgentManifest } from '../engine';

export const lettaManifest: AgentManifest = {
  id: 'letta',
  rules: [
    {
      id: 'osc_progress_blocked',
      state: 'blocked',
      priority: 1400,
      region: 'osc_progress',
      visibleBlocker: true,
      regex: [String.raw`^4;3(?:;|$)`],
    },
    {
      id: 'osc_title_blocked',
      state: 'blocked',
      priority: 1300,
      region: 'osc_title',
      visibleBlocker: true,
      regex: [String.raw`^\[ [!.] \] Action Required(?: \| |$)`],
    },
    {
      id: 'command_approval',
      state: 'blocked',
      priority: 1200,
      region: 'bottom_non_empty_lines(20)',
      visibleBlocker: true,
      contains: ['Run this command?', 'Enter to select · Esc to cancel'],
    },
    {
      id: 'osc_title_working',
      state: 'working',
      priority: 900,
      region: 'osc_title',
      visibleWorking: true,
      regex: [String.raw`(?:^| )[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2847\u280f](?: |$)`],
    },
    {
      id: 'active_status',
      state: 'working',
      priority: 850,
      region: 'bottom_non_empty_lines(8)',
      visibleWorking: true,
      lineRegex: [String.raw`^\s*(?:\S+\s+)+is(?: \S+)*\u2026 \((?:esc to interrupt(?: \u00b7 .*)?|interrupting)\)\s*$`],
    },
    {
      id: 'running_tool',
      state: 'working',
      priority: 800,
      region: 'bottom_non_empty_lines(8)',
      visibleWorking: true,
      lineRegex: [String.raw`^\s*(?:\u2514\s*)?Running\.\.\.\s*(?:\(.*\))?$`],
    },
    {
      id: 'profile_selector',
      state: 'unknown',
      priority: 700,
      region: 'bottom_non_empty_lines(12)',
      contains: ['Create a new agent (--new)', 'Enter select · Esc exit'],
    },
    {
      id: 'composer_input',
      state: 'unknown',
      priority: 150,
      region: 'bottom_non_empty_lines(8)',
      lineRegex: [String.raw`^\s*\u203a\s+\S.*$`],
      not: [{ lineRegex: [String.raw`^\s*\u203a\s+Try\s+"`] }],
    },
    {
      id: 'composer_idle',
      state: 'idle',
      priority: 100,
      region: 'bottom_non_empty_lines(8)',
      visibleIdle: true,
      any: [{ lineRegex: [String.raw`^\s*\u203a\s*$`] }, { lineRegex: [String.raw`^\s*\u203a\s+Try\s+"`] }],
      not: [
        { lineRegex: [String.raw`^\s*(?:\S+\s+)+is(?: \S+)*\u2026 \((?:esc to interrupt(?: \u00b7 .*)?|interrupting)\)\s*$`] },
        { lineRegex: [String.raw`^\s*(?:\u2514\s*)?Running\.\.\.\s*(?:\(.*\))?$`] },
      ],
    },
    {
      id: 'no_live_state_evidence',
      state: 'unknown',
      priority: 0,
      region: 'whole_recent',
      regex: [String.raw`(?s)^.*$`],
    },
  ],
};
