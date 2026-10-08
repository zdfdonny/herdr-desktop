/**
 * gemini manifest —— 对应 herdr `src/detect/manifests/gemini.toml`。
 */

import type { AgentManifest } from '../engine';

export const geminiManifest: AgentManifest = {
  id: 'gemini',
  rules: [
    {
      id: 'apply_or_allow_change',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      visibleBlocker: true,
      any: [
        { contains: ['│ Apply this change'] },
        { contains: ['│ Allow execution'] },
        {
          all: [
            { contains: ['yes'] },
            { any: [{ contains: ['waiting for user confirmation'] }, { contains: ['│ Do you want to proceed'] }, { contains: ['do you want to proceed?'] }] },
          ],
        },
        { lineRegex: [String.raw`(?i)^\s*\u276f.*(yes|allow)`] },
      ],
    },
    {
      id: 'esc_cancel_working',
      state: 'working',
      priority: 100,
      region: 'whole_recent',
      visibleWorking: true,
      contains: ['esc to cancel'],
    },
  ],
};
