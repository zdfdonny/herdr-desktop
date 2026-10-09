/**
 * 提示音播放 —— 移植自 herdr `src/sound.rs` 的声音提示能力。
 *
 * herdr 把 mp3 内嵌进二进制，再通过系统播放器播放（afplay / Windows
 * MediaPlayer / Linux 播放器）；desktop 侧 Renderer 已有应用内 toast 与系统
 * 通知的既有路径，声音同样在 Renderer 用 HTML5 Audio 播放，跨平台且无需
 * 额外依赖。Electron 默认 autoplayPolicy 为 no-user-gesture-required，
 * 无需用户手势即可播放。
 */

import doneUrl from './assets/sounds/done.mp3';
import requestUrl from './assets/sounds/request.mp3';

/** 通知音类型（对应 herdr 的 `sound::Sound`）。 */
export type NotificationSound = 'done' | 'request';

/**
 * 播放一条提示音。
 *
 * - `done`：agent 完成工作（对应 herdr 的 `Sound::Done`）。
 * - `request`：agent 需要输入（对应 herdr 的 `Sound::Request`）。
 *
 * 失败静默忽略：无音频设备、自动播放被拦、文件不可用等场景不应阻断通知流程。
 */
export function playNotificationSound(sound: NotificationSound): void {
  try {
    const url = sound === 'done' ? doneUrl : requestUrl;
    const audio = new Audio(url);
    void audio.play().catch(() => {
      /* 自动播放被拦或文件不可用时静默忽略 */
    });
  } catch {
    /* 音频 API 不可用时静默忽略 */
  }
}
