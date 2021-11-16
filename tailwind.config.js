const isProduction = process.env.NODE_ENV === 'production'

module.exports = {
  purge: {
    content: [
      './public/**/*.html',
      './src/**/*.svelte',
    ],
    enabled: isProduction,
  },
  darkMode: false, // or 'media' or 'class'
  theme: {
    extend: {},
  },
  variants: {
    extend: {
      opacity: ['disabled'],
    },
  },
  plugins: [],
}
