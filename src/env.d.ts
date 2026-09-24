/// <reference types="vite/client" />

import type { HerdrDesktopApi } from '../shared/protocol';

declare global {
  interface Window {
    herdrDesktop: HerdrDesktopApi;
  }
}

export {};
