// Only needed for svelte-jester and IDEs
const sveltePreprocess = require('svelte-preprocess');
module.exports = {
  preprocess: sveltePreprocess({ typescript: true}),
};
