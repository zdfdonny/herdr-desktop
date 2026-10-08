/**
 * kilo manifest —— 对应 herdr `src/detect/manifests/kilo.toml`。
 */

import type { AgentManifest } from '../engine';

export const kiloManifest: AgentManifest = {
  id: 'kilo',
  rules: [
    {
      id: 'opencode_permission',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      visibleBlocker: true,
      any: [
        { contains: ['△ Permission required'] },
        {
          contains: ['esc dismiss'],
          any: [{ contains: ['enter confirm'] }, { contains: ['enter submit'] }, { contains: ['enter toggle'] }],
          all: [{ any: [{ contains: ['↑↓ select'] }, { contains: ['⇆ tab'] }] }],
        },
      ],
    },
    {
      id: 'esc_interrupt_working',
      state: 'working',
      priority: 100,
      region: 'whole_recent',
      visibleWorking: true,
      contains: ['esc interrupt'],
    },
  ],
};
