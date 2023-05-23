import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import sveltePreprocess from 'svelte-preprocess';
import tailwind from 'tailwindcss';
import autoprefixer from 'autoprefixer'
import mkcert from 'vite-plugin-mkcert';

export default defineConfig(async ({ command, mode }) => {
  const postssConfig = {
    plugins: [tailwind(), autoprefixer()],
  };
  let mkcertConfig = mkcert();
  try {
    await (mkcertConfig as any).config({});
  } catch (e) {
    console.warn('mkcert certificate not found, https will not be available');
    console.warn(e);
    mkcertConfig = undefined;
  }
  return {
    assetsInclude: ['assets/**'],
    server: { https: mkcertConfig ? true : false },
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
      mkcertConfig,
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
