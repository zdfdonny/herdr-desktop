/**
 * kiro manifest —— 对应 herdr `src/detect/manifests/kiro.toml`。
 */

import type { AgentManifest } from '../engine';

export const kiroManifest: AgentManifest = {
  id: 'kiro',
  rules: [
    {
      id: 'live_prompt_idle',
      state: 'idle',
      priority: 1100,
      region: 'bottom_non_empty_lines(4)',
      visibleIdle: true,
      lineRegex: [String.raw`(?i)^\s*[>\u203a]\s*ask a question or describe a task(?:\s+(?:enter|\u21b5))?\s*$`],
    },
    {
      id: 'tool_approval',
      state: 'blocked',
      priority: 1050,
      region: 'bottom_non_empty_lines(8)',
      visibleBlocker: true,
      any: [
        {
          all: [
            {
              regex: [
                String.raw`(?is)(?:^|\n)\s*esc\s+to\s+close\b(?:[^\n]*\bto\s+navigate\b[^\n]*|.*\bto\s+navigate\b.*\bto\s+select\b.*\btab\s+to\s+edit|[^\n]*\benter\s+to\s+see\s+more\s+options)\s*$`,
              ],
            },
            {
              any: [
                {
                  lineRegex: [
                    String.raw`(?i)^\s*[>\u276f]\s*(?:allow|always allow|deny|always deny)\s*$`,
                    String.raw`(?i)^\s*(?:[>\u276f]\s*)?allow\s*$`,
                    String.raw`(?i)^\s*(?:[>\u276f]\s*)?always allow\s*$`,
                    String.raw`(?i)^\s*(?:[>\u276f]\s*)?deny\s*$`,
                    String.raw`(?i)^\s*(?:[>\u276f]\s*)?always deny\s*$`,
                  ],
                },
                {
                  lineRegex: [
                    String.raw`(?i)^\s*[>\u276f]\s*(?:yes, single permission|trust, always allow in this session|no \(tab to edit\))\s*$`,
                    String.raw`(?i)^\s*(?:[>\u276f]\s*)?yes, single permission\s*$`,
                    String.raw`(?i)^\s*(?:[>\u276f]\s*)?trust, always allow in this session\s*$`,
                    String.raw`(?i)^\s*(?:[>\u276f]\s*)?no \(tab to edit\)\s*$`,
                  ],
                },
                {
                  lineRegex: [
                    String.raw`(?i)^\s*[>\u276f]\s*(?:trust\b.*|entire tool)\s*$`,
                    String.raw`(?i)^\s*(?:[>\u276f]\s*)?(?:trust )?entire tool(?:\s+\([^\n]*\))?(?:\s+(?:session|workspace|always))?\s*$`,
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'tool_approval_edit',
      state: 'blocked',
      priority: 1045,
      region: 'whole_recent',
      visibleBlocker: true,
      regex: [
        String.raw`(?im)(?:^|\n)[ \t]*[-\u2500]+[ \t]*\n[^\n]*requires\s+approval\s*[\u00b7.]\s*modify\s+request[ \t]*\n(?:[ \t]*\n|[^\n]*[^\s\u2500-][^\n]*\n)*?[ \t]*[>\u203a][ \t]*[^\n]*\n(?:[ \t]*\n|[^\n]*[^\s\u2500-][^\n]*\n)*[ \t]*[-\u2500]+[ \t]*\n[ \t]*esc[ \t]+to[ \t]+close[ \t]*\n?$`,
      ],
    },
    {
      id: 'crew_approval',
      state: 'blocked',
      priority: 1040,
      region: 'bottom_non_empty_lines(8)',
      visibleBlocker: true,
      contains: ['tool approval', 'approve all pending', 'configure individually (agent monitor)', 'exit (cancel subagents)'],
    },
    {
      id: 'question_panel',
      state: 'blocked',
      priority: 1030,
      region: 'bottom_non_empty_lines(8)',
      visibleBlocker: true,
      contains: ['to navigate', 'to submit', 'esc to cancel'],
    },
    {
      id: 'live_working_footer',
      state: 'working',
      priority: 950,
      region: 'bottom_non_empty_lines(4)',
      visibleWorking: true,
      contains: ['kiro is working', 'type to steer', 'ctrl+s to queue'],
    },
    {
      id: 'osc_title_working',
      state: 'working',
      priority: 900,
      region: 'osc_title',
      visibleWorking: true,
      regex: [String.raw`(?i)^[\u25d0\u25d3\u25d1\u25d2/|\-]\s+kiro:`],
    },
    {
      id: 'osc_progress_working',
      state: 'working',
      priority: 890,
      region: 'osc_progress',
      visibleWorking: true,
      regex: [String.raw`^4;3;?$`],
    },
  ],
};
