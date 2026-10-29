/**
 * 没有官方集成的智能体：只做屏幕检测与识别。
 *
 * 这些智能体的状态**完全**由屏幕判定（没有 hook 可以依赖），因此策略里
 * `screenOwnsCompletion` 必须保持 true —— 否则它们永远不会响完成提示音。
 * 它们也不支持会话恢复（不在恢复白名单里）。
 */

import { ampManifest } from '../../detect/manifests/amp';
import { clineManifest } from '../../detect/manifests/cline';
import { geminiManifest } from '../../detect/manifests/gemini';
import { kiroManifest } from '../../detect/manifests/kiro';
import { makiManifest } from '../../detect/manifests/maki';
import { museManifest } from '../../detect/manifests/muse';
import type { AgentDescriptor } from '../descriptor';
import { statePolicy } from '../spec/policy';

export const gemini: AgentDescriptor = {
  id: 'gemini',
  detectionPriority: 40,
  label: 'Gemini CLI',
  command: () => 'gemini',
  detection: { identity: '\\bgemini\\b', manifest: geminiManifest },
  policy: statePolicy({}),
};

export const cline: AgentDescriptor = {
  id: 'cline',
  detectionPriority: 80,
  label: 'Cline',
  command: () => 'cline',
  detection: { identity: '\\bcline\\b', aliases: ['.cline'], manifest: clineManifest },
  policy: statePolicy({}),
};

export const kiro: AgentDescriptor = {
  id: 'kiro',
  detectionPriority: 140,
  label: 'Kiro CLI',
  command: () => 'kiro-cli',
  detection: { identity: '\\bkiro(?:-cli)?\\b', aliases: ['kiro-cli'], manifest: kiroManifest },
  policy: statePolicy({}),
};

export const amp: AgentDescriptor = {
  id: 'amp',
  detectionPriority: 160,
  label: 'Amp',
  command: () => 'amp',
  detection: { identity: '\\bamp\\b', aliases: ['amp-local'], manifest: ampManifest },
  policy: statePolicy({}),
};

export const maki: AgentDescriptor = {
  id: 'maki',
  detectionPriority: 230,
  label: 'Maki',
  command: () => 'maki',
  detection: { identity: '\\bmaki\\b', manifest: makiManifest },
  policy: statePolicy({}),
};

export const muse: AgentDescriptor = {
  id: 'muse',
  detectionPriority: 240,
  label: 'Muse',
  command: () => 'muse',
  detection: {
    identity: '\\bmuse\\b',
    aliases: ['muse-code', 'muse-cli'],
    manifest: museManifest,
  },
  policy: statePolicy({}),
};
