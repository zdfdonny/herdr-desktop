/**
 * test:json-hooks-installer 的打包脚本。
 *
 * 入口同时引用了 `electron/agents/installers/json-hooks-installer.ts`（无外部依赖）
 * 和 `electron/runtime/integration/index.ts`（会拉进 `?raw` 资产），
 * 所以仍需复用安装器快照测试那套 `?raw` 插件。
 */
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const rawPlugin = {
  name: 'vite-raw',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'vite-raw',
    }));
    build.onLoad({ filter: /.*/, namespace: 'vite-raw' }, (args) => ({
      contents: fs.readFileSync(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

await esbuild.build({
  entryPoints: ['scripts/test-json-hooks-installer.entry.mjs'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/json-hooks-installer.cjs',
  plugins: [rawPlugin],
  external: ['jsonc-parser'],
  logLevel: 'warning',
});
