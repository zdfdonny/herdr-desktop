/**
 * pi manifest —— 对应 herdr `src/detect/manifests/pi.toml`。
 */

import type { AgentManifest } from '../engine';

export const piManifest: AgentManifest = {
  id: 'pi',
  rules: [
    {
      id: 'working_literal',
      state: 'working',
      priority: 100,
      region: 'whole_recent',
      visibleWorking: true,
      any: [
        { contains: ['Working...'] },
        { lineRegex: [String.raw`^[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2847\u280f] Working$`] },
      ],
    },
    {
      id: 'working_border',
      state: 'working',
      priority: 100,
      region: 'bottom_non_empty_lines(12)',
      visibleWorking: true,
      any: [
        { lineRegex: [String.raw`^\u2500\u2500 [\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2847\u280f] Working \u2500+$`] },
        { lineRegex: [String.raw`^[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2847\u280f] Working$`] },
      ],
    },
  ],
};
