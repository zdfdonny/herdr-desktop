/**
 * qwen manifest —— 对应 herdr `src/detect/manifests/qwen.toml`。
 */

import type { AgentManifest } from '../engine';

export const qwenManifest: AgentManifest = {
  id: 'qwen',
  rules: [
    {
      id: 'osc_title_blocked',
      state: 'blocked',
      priority: 1200,
      region: 'osc_title',
      visibleBlocker: true,
      regex: [String.raw`^\u2733\ufe0e? `],
    },
    {
      id: 'osc_title_working',
      state: 'working',
      priority: 1100,
      region: 'osc_title',
      visibleWorking: true,
      regex: [String.raw`^\u25d0\ufe0e? `],
    },
    {
      id: 'waiting_for_confirmation',
      state: 'blocked',
      priority: 1000,
      region: 'bottom_non_empty_lines(20)',
      visibleBlocker: true,
      lineRegex: [String.raw`^\s*\u280f\s+.*\.\.\.\s*$`],
      any: [
        { contains: ['Waiting for user confirmation...'] },
        { contains: ['等待用户确认...'] },
        { contains: ['等待用戶確認...'] },
        { contains: ['Warten auf Benutzerbestätigung...'] },
        { contains: ["En attente de la confirmation de l'utilisateur..."] },
        { contains: ['ユーザーの確認を待っています...'] },
        { contains: ['Aguardando confirmação do usuário...'] },
        { contains: ['Ожидание подтверждения от пользователя...'] },
        { contains: ["Esperant la confirmació de l'usuari..."] },
      ],
    },
    {
      id: 'tool_confirmation',
      state: 'blocked',
      priority: 990,
      region: 'bottom_non_empty_lines(20)',
      visibleBlocker: true,
      contains: ['yes, allow once'],
      any: [
        { contains: ['apply this change?'] },
        { contains: ['allow execution of:'] },
        { contains: ['allow execution of mcp tool'] },
        { contains: ['do you want to proceed?'] },
        { contains: ['shell command execution'] },
      ],
    },
    {
      id: 'question_dialog',
      state: 'blocked',
      priority: 980,
      region: 'bottom_non_empty_lines(20)',
      visibleBlocker: true,
      lineRegex: [
        String.raw`^\s*[\u276f\u203a]\s*(?:\[(?: |\u2713)\]\s*)?\d+\.\s+`,
        String.raw`^\s*\u2191/\u2193\s*:.*(?:Enter|Return)\s*:`,
      ],
    },
    {
      id: 'folder_trust_dialog',
      state: 'blocked',
      priority: 970,
      region: 'bottom_non_empty_lines(20)',
      visibleBlocker: true,
      contains: ['do you trust this folder?', 'trust folder (', "don't trust (esc)"],
    },
    {
      id: 'cancel_hint_working',
      state: 'working',
      priority: 900,
      region: 'bottom_non_empty_lines(8)',
      visibleWorking: true,
      lineRegex: [String.raw`^\s*(?:[\u2801-\u28ff]|\.{1,2})\s+.*\(\d+(?:m(?:\s+\d+s)?|s).*\s\u00b7\sesc to cancel\)\s*$`],
    },
    {
      id: 'narrow_cancel_hint_working',
      state: 'working',
      priority: 890,
      region: 'bottom_non_empty_lines(8)',
      visibleWorking: true,
      lineRegex: [String.raw`^\s*\(\d+(?:m(?:\s+\d+s)?|s)\s\u00b7\sesc to cancel\)\s*$`],
    },
    {
      id: 'osc_tool_progress_working',
      state: 'working',
      priority: 850,
      region: 'osc_progress',
      visibleWorking: true,
      regex: [String.raw`^4;3(?:;|$)`],
    },
    {
      id: 'composer_idle',
      state: 'idle',
      priority: 100,
      region: 'bottom_non_empty_lines(30)',
      visibleIdle: true,
      lineRegex: [String.raw`^\s*>\s*(?:type\s*)?.*$`],
      any: [
        { contains: ['type your message'] },
        { contains: ['your message or @path/to/file'] },
        { contains: ['@path/to/file'] },
        { contains: ['type', 'mes', 'sage', '@pat', 'h/to', '/fil'] },
      ],
    },
  ],
};
