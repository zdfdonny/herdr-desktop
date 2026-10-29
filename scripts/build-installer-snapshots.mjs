/**
 * test:installer-snapshots 的打包脚本。
 *
 * 为什么需要它（而不是直接用 `esbuild` 命令行）：
 * `electron/agents/assets.ts` 用 Vite 的 `?raw` 内联集成脚本，
 * esbuild 不认识这个后缀 —— 但我们要测的配置改写函数恰好都在同一个模块里。
 * 这里用一个 10 行的插件把 `?raw` 解析成「文件内容的字符串导出」，
 * 语义与 Vite 一致，于是无需为了可测性去搬动上百行代码。
 */

import esbuild from 'esbuild';
import fs from 'node:fs';

/** 把 `xxx?raw` 变成 `export default "<文件内容>"`，与 Vite 行为一致。 */
const rawPlugin = {
  name: 'vite-raw',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: require.resolve_path(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'vite-raw',
    }));
    build.onLoad({ filter: /.*/, namespace: 'vite-raw' }, (args) => ({
      contents: fs.readFileSync(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

// esbuild 的 onResolve 需要绝对路径；这里做最小解析（同目录相对路径 + 上一级）。
// 简化实现：交给 node 的 path.resolve。
import path from 'node:path';
const require = { resolve_path: (dir, p) => path.resolve(dir, p) };

await esbuild.build({
  entryPoints: ['scripts/test-installer-snapshots.entry.mjs'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/installer-snapshots.cjs',
  plugins: [rawPlugin],
  // jsonc-parser 是 UMD 包，运行时才 require 子路径；打进 bundle 会断掉，交给 node 解析。
  external: ['jsonc-parser'],
  logLevel: 'warning',
});
