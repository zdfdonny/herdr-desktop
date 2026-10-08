/**
 * codex manifest —— 对应 herdr `src/detect/manifests/codex.toml`。
 */

import type { AgentManifest } from '../engine';

export const codexManifest: AgentManifest = {
  id: 'codex',
  rules: [
    {
      id: 'osc_title_blocked',
      state: 'blocked',
      priority: 1100,
      region: 'osc_title',
      visibleBlocker: true,
      contains: ['Action Required'],
    },
    {
      id: 'osc_title_working',
      state: 'working',
      priority: 1050,
      region: 'osc_title',
      visibleWorking: true,
      regex: [String.raw`(?:^| )[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2847\u280f](?: |$)`],
    },
    {
      id: 'transcript_viewer',
      state: 'unknown',
      priority: 1000,
      region: 'after_last_prompt_marker',
      skipStateUpdate: true,
      contains: ['↑/↓ to scroll', 'pgup/pgdn to', 'home/end to jump', 'q to quit'],
      any: [{ contains: ['esc to edit prev'] }, { contains: ['esc/← to edit prev'] }],
    },
    {
      id: 'trust_directory',
      state: 'blocked',
      priority: 950,
      region: 'top_non_empty_lines(20)',
      visibleBlocker: true,
      all: [
        { any: [{ regex: [String.raw`^> You are in [^\r\n]+(?:\r?\n|$)`] }, { contains: ['Folder access'] }] },
        {
          any: [
            { regex: [String.raw`(?s)Do\s+you\s+trust\s+the\s+contents\s+of\s+this\s+directory\?`] },
            {
              all: [
                { contains: ['Trust this folder?', 'Codex can read, edit, and run files here'] },
                { any: [{ contains: ['Trust and continue'] }, { contains: ['enter continue'] }] },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'startup_update',
      state: 'blocked',
      priority: 950,
      region: 'bottom_non_empty_lines(20)',
      visibleBlocker: true,
      contains: ['Update available!', 'Update now'],
      regex: [String.raw`Skip\s+until\s+next\s+version`, String.raw`Press enter to continue\s*$`],
    },
    {
      id: 'live_strong_blocker',
      state: 'blocked',
      priority: 900,
      region: 'after_last_prompt_marker',
      visibleBlocker: true,
      any: [
        { contains: ['press enter to confirm or esc to cancel'] },
        { contains: ['enter to submit answer'] },
        { contains: ['enter to submit all'] },
        { contains: ['allow command?'] },
        { contains: ['All Results', 'Filesystem Only', 'Plugins'] },
      ],
    },
    {
      id: 'weak_blocker',
      state: 'blocked',
      priority: 600,
      region: 'whole_recent_without_current_prompt_marker',
      not: [
        { regex: [String.raw`(?m)^\u203a[\u2801\u2802\u2804\u2808\u2810\u2820\u2840\u2880][^\n]*(?:\n(?:[^\u2022\u25a0\u2717\u2713\n][^\n]*)?)*$`] },
      ],
      any: [
        { contains: ['[y/n]'] },
        { contains: ['yes (y)'] },
        { contains: ['do you want to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
        { contains: ['would you like to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
      ],
    },
    {
      id: 'screen_working_fallback',
      state: 'working',
      priority: 500,
      region: 'before_current_prompt_marker',
      visibleWorking: true,
      any: [{ contains: [' to interrupt)'] }, { contains: ['s)'] }],
      regex: [
        String.raw`(?m)^(?:[\u2022\u25e6][ \t]+)?[^\s\u203a\u2022\u25e6\u25a0\u2717\u2713\u2500][^\r\n]* \((?:[0-9]+[hm] )*[0-9]+s(?: \u2022 [^\r\n]+? to interrupt)?\)(?: \u00b7 [^\r\n]*)?(?:\r?\n(?:[^\u2022\u25e6\u203a\u25a0\u2717\u2713\u2500\r\n][^\r\n]*|\u2022[ \t]+(?:Queued\s+follow-up\s+inputs|Messages\s+to\s+be\s+submitted\s+after\s+next\s+tool\s+call(?:\s+\(press\s+[^\r\n]+?\s+to\s+interrupt\s+and\s+send\s+immediately\))?|Messages\s+to\s+be\s+submitted\s+at\s+end\s+of\s+turn)|\u203a[\u2801\u2802\u2804\u2808\u2810\u2820\u2840\u2880][^\r\n]*)?)*\s*$`,
      ],
      not: [
        { lineRegex: [String.raw`^(?:[\u2022\u25e6][ \t]+)?Reconnect failed \u2014 check the endpoint, then relaunch \([0-9hms ]+\)$`] },
      ],
    },
    {
      id: 'osc_title_idle',
      state: 'idle',
      priority: 100,
      region: 'osc_title',
      visibleIdle: true,
      regex: [String.raw`\S`],
      not: [
        { regex: [String.raw`(?:^| )[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2847\u280f](?: |$)`] },
        { contains: ['Action Required'] },
      ],
    },
  ],
};
