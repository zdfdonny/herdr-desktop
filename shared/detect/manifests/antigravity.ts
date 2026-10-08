/**
 * antigravity manifest —— 对应 herdr `src/detect/manifests/antigravity.toml`。
 *
 * antigravity 是 session-identity-only，状态只来自屏幕。它的 idle footer 是
 * "? for shortcuts"；working 时 footer 变 "esc to cancel" 且 prompt 上方出现
 * 盲文 spinner；对话框（permission/question/trust）显示 "navigate" 等按键提示。
 */

import type { AgentManifest } from '../engine';

export const antigravityManifest: AgentManifest = {
  id: 'antigravity',
  rules: [
    {
      id: 'permission_prompt',
      state: 'blocked',
      priority: 300,
      region: 'bottom_non_empty_lines(2)',
      visibleBlocker: true,
      contains: ['navigate', 'tab amend'],
    },
    {
      id: 'question_prompt',
      state: 'blocked',
      priority: 290,
      region: 'bottom_non_empty_lines(2)',
      visibleBlocker: true,
      contains: ['navigate', 'esc skip'],
    },
    {
      id: 'trust_prompt',
      state: 'blocked',
      priority: 280,
      region: 'bottom_non_empty_lines(8)',
      visibleBlocker: true,
      contains: ['do you trust the contents of this project?', 'yes, i trust this folder', 'enter confirm'],
    },
    {
      id: 'legacy_permission_prompt',
      state: 'blocked',
      priority: 270,
      region: 'whole_recent',
      visibleBlocker: true,
      contains: ['requesting permission for:'],
      any: [{ contains: ['do you want to proceed?'] }, { contains: ['tab amend', 'edit command'] }],
    },
    {
      id: 'esc_cancel_footer_working',
      state: 'working',
      priority: 110,
      region: 'bottom_non_empty_lines(2)',
      visibleWorking: true,
      regex: [String.raw`(?m)^\s*\u2500{3,}\s*esc to cancel\b`],
    },
    {
      id: 'spinner_working',
      state: 'working',
      priority: 100,
      region: 'bottom_non_empty_lines(12)',
      visibleWorking: true,
      lineRegex: [String.raw`^\s*[\u2801-\u28ff]+\s+\S`],
    },
  ],
};
