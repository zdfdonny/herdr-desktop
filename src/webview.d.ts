/**
 * Electron `<webview>` 标签的 JSX 类型声明。
 *
 * `<webview>` 不是标准 HTML 元素，@types/react 未内置其 intrinsic，
 * 这里按 Electron 的 webview tag 属性补一个最小声明，供 WebPane 使用。
 */

import type * as React from 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        src?: string;
        /** 会话分区（隔离各 pane 的 Cookie）。 */
        partition?: string;
        /** 是否允许弹出窗口。 */
        allowpopups?: string;
      };
    }
  }
}

export {};
