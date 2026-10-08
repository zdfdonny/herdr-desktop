/**
 * opencode manifest —— 对应 herdr `src/detect/manifests/opencode.toml`。
 */

import type { AgentManifest } from '../engine';

export const opencodeManifest: AgentManifest = {
  id: 'opencode',
  rules: [
    {
      id: 'permission_required',
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
      id: 'interrupt_hint_working',
      state: 'working',
      priority: 110,
      region: 'whole_recent',
      visibleWorking: true,
      any: [
        { contains: ['esc to interrupt'] },
        { contains: ['ctrl+c to interrupt'] },
        { contains: ['press esc to interrupt'] },
        { lineRegex: [String.raw`(?i).*opencode.*esc (again to )?interrupt`] },
      ],
    },
    {
      id: 'progress_bar_working',
      state: 'working',
      priority: 100,
      region: 'whole_recent',
      visibleWorking: true,
      regex: [String.raw`(\u25a0|\u2b1d){4,}`],
    },
  ],
};
