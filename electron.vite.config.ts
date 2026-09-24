import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

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
