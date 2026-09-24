import React from 'react';
import ReactDOM from 'react-dom/client';

// xterm 自带样式先加载，随后由应用样式覆盖，
// 保证终端背景等令牌始终以主题为准（避免 .xterm-viewport 的 #000 露底）。
import '@xterm/xterm/css/xterm.css';
import './styles/global.css';
import './styles/components.css';

import App from './App';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
