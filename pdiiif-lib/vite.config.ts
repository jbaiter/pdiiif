import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import MagicString from 'magic-string';

// Hacky plugin that prevents inlining @squoosh/mozjpeg/enc wasm file as
// base64 string in the worker bundle, resulting in a 10x smaller bundle size.
function interceptWASM() {
  return {
    name: 'intercept-wasm',
    transform(code, id) {
      if (id.includes('mozjpeg_enc.js')) {
        const magicString = new MagicString(code);
        magicString.replace(
          /new URL\("mozjpeg_enc\.wasm",import\.meta\.url\)\.href/,
          'null'
        );
        return {
          code: magicString.toString(),
          map: magicString.generateMap(),
        };
      }
    },
  };
}

export default defineConfig({
  base: './',
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'mjs' : 'cjs'}`,
    },
    sourcemap: true,
    rollupOptions: {
      external: ['prom-client', 'util', 'events', 'zlib', 'crypto'],
    },
  },
  plugins: [
    dts({
      insertTypesEntry: true,
    }),
  ],
  worker: {
    format: 'es',
    plugins: () => [interceptWASM()],
  },
});
