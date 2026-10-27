import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { babel } from '@rollup/plugin-babel';

// Standard decorators for native classes.
//
// The engine annotates native members with @nativeClass/@nativeMethod/
// @nativeProperty (see web/engine-js/common/native.js).  Decorators are a
// stage-3 syntax that esbuild - Vite's JS transformer - does not implement, so
// annotated files are compiled by Babel first (configuration lives in
// babel.config.json); every other file keeps the plain esbuild path.  Only
// method/getter/setter decorators are used, so the class-properties transform
// is intentionally not enabled: it would otherwise change the initialization
// semantics of class fields in the same files.
const annotated = /@(nativeClass|nativeConstructor|nativeMethod|nativeEvent|nativeProperty|nativeMembers)\b/;

const nativeDecorators = () => ({
  ...babel({
    babelHelpers: 'bundled',
    extensions: ['.js'],
    babelrc: false,
    // A custom filter cannot be combined with include/exclude, so both the
    // dependency and the annotation checks live here.
    filter: (id, code) =>
      !id.includes('node_modules') && annotated.test(code),
  }),
  enforce: 'pre',
});

export default defineConfig({
  root: resolve('web'),
  plugins: [nativeDecorators()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8081',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: resolve('web/build'),
    emptyOutDir: true,
  },
});
