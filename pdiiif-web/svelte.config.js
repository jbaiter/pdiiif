// Only needed for svelte-jester and IDEs
import sveltePreprocess from 'svelte-preprocess';
export default {
  preprocess: sveltePreprocess({ typescript: true}),
};
