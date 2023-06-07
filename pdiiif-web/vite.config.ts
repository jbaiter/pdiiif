import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import sveltePreprocess from 'svelte-preprocess';
import tailwind from 'tailwindcss';
import autoprefixer from 'autoprefixer'

export default defineConfig(async ({ command, mode }) => {
  const postssConfig = {
    plugins: [tailwind(), autoprefixer()],
  };
  return {
    assetsInclude: ['assets/**'],
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
