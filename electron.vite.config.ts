import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

/*
 * sync-icon.js 是 CommonJS（供 npm run icon 直接执行），这里用 createRequire 引入。
 * 它把 build/icon.png 复制到 src/assets/app-icon.png —— 渲染层 Vite root 是 src/，
 * 取不到 root 外的 build/，渲染层 import 的必须是 root 内那份。
 *
 * 放在配置里而不是 npm 的 prebuild 脚本上：dist:* 系列内部是裸的
 * `electron-vite build`，不会触发 prebuild，图标就会漏同步。
 * 配置每次构建都会被加载，dev / build / dist:* 因此都覆盖到。
 */
const { syncIcon } = createRequire(import.meta.url)('./scripts/sync-icon.js');
const iconResult = syncIcon();
console.log(`[icon] build/icon.png -> src/assets/app-icon.png (${iconResult.status})`);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('shared'),
        '@electron': resolve('electron'),
      },
    },
    build: {
      outDir: 'dist-electron/main',
      target: 'node22',
      lib: {
        entry: resolve('electron/main.ts'),
        formats: ['cjs'],
      },
      rollupOptions: {
        output: {
          entryFileNames: '[name].js',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('shared'),
      },
    },
    build: {
      outDir: 'dist-electron/preload',
      target: 'node22',
      lib: {
        entry: resolve('electron/preload.ts'),
        formats: ['cjs'],
      },
      rollupOptions: {
        output: {
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    root: 'src',
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('shared'),
        '@renderer': resolve('src'),
      },
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: {
          index: resolve('src/index.html'),
        },
      },
    },
  },
});
