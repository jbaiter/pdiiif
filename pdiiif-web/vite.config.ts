import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import sveltePreprocess from 'svelte-preprocess';
import tailwind from 'tailwindcss';
import autoprefixer from 'autoprefixer'
import mkcert from 'vite-plugin-mkcert';

export default defineConfig(({ command, mode }) => {
  const postssConfig = {
    plugins: [tailwind(), autoprefixer()],
  };
  return {
    assetsInclude: ['assets/**'],
    server: { https: true },
    plugins: [
      svelte({
        preprocess: [
          sveltePreprocess({
            typescript: true,
            postcss: postssConfig,
          }),
        ],
        prebundleSvelteLibraries: true,
      }),
      mkcert(),
    ],
    css: {
      postcss: postssConfig,
    },
    rollupdedupe: ['svelte'],
    envPrefix: 'PDIIIF_',
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version),
    },
  };
});
