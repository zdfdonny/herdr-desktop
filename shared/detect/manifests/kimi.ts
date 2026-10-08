/**
 * kimi manifest —— 对应 herdr `src/detect/manifests/kimi.toml`。
 */

import type { AgentManifest } from '../engine';

export const kimiManifest: AgentManifest = {
  id: 'kimi',
  rules: [
    {
      id: 'current_approval_panel',
      state: 'blocked',
      priority: 400,
      region: 'whole_recent',
      visibleBlocker: true,
      contains: ['↵ confirm'],
      any: [
        { contains: ['run this command?'] },
        { contains: ['write this file?'] },
        { contains: ['apply these edits?'] },
        { contains: ['stop this task?'] },
        { contains: ['ready to build with this plan?'] },
        { lineRegex: [String.raw`(?i)^\s*\u25b6?\s*approve .*\?$`] },
      ],
      all: [
        { contains: [' choose'] },
        { any: [{ contains: ['approve'] }, { contains: ['reject'] }, { contains: ['revise'] }] },
      ],
    },
    {
      id: 'question_panel',
      state: 'blocked',
      priority: 390,
      region: 'whole_recent',
      visibleBlocker: true,
      contains: ['↑↓ select', 'esc cancel'],
      lineRegex: [String.raw`^\s*question\s*$`, String.raw`^\s*\? `],
      any: [{ contains: ['↵ choose'] }, { contains: ['↵ toggle'] }, { contains: ['↵ save'] }],
    },
    {
      id: 'legacy_approval_panel',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      contains: ['requesting approval', 'reject'],
      any: [{ contains: ['approve once'] }, { contains: ['approve for this session'] }],
      all: [{ any: [{ contains: ['1/2/3/4 choose'] }, { contains: ['↵ confirm'] }] }],
    },
    {
      id: 'background_agent_status_working',
      state: 'working',
      priority: 120,
      region: 'bottom_non_empty_lines(3)',
      visibleWorking: true,
      lineRegex: [String.raw`(?i)\bkimi[-\w.]*\s+thinking\b.*\[[1-9][0-9]*\s+agents?\s+running\]`],
    },
    {
      id: 'moon_spinner_working',
      state: 'working',
      priority: 100,
      region: 'whole_recent',
      visibleWorking: true,
      lineRegex: [String.raw`^\s*(\ud83c\udf15|\ud83c\udf16|\ud83c\udf17|\ud83c\udf18|\ud83c\udf11|\ud83c\udf12|\ud83c\udf13|\ud83c\udf14)\s*$`],
    },
    {
      id: 'braille_spinner_working',
      state: 'working',
      priority: 90,
      region: 'whole_recent',
      visibleWorking: true,
      lineRegex: [String.raw`(?i)^\s*[\u2800-\u28ff]+\s*(thinking\.\.\.|working\.\.\.|using )`],
    },
  ],
};
