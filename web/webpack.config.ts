// Config based on https://github.com/baileyherbert/svelte-webpack-starter/blob/master/webpack.config.ts
import Webpack from 'webpack';
import { CleanWebpackPlugin } from 'clean-webpack-plugin';

import path from 'path';

const mode = process.env.NODE_ENV ?? 'development';
const isProduction = mode === 'production';
const isDevelopment = !isProduction;

const config: Webpack.Configuration = {
  mode: isProduction ? 'production' : 'development',
  entry: '../src/index.ts',
  plugins: [
    // Replace some node dependencies of pdfkit/fontkit with browser-compatible
    // versions
    new Webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser',
    }),
  ],
  resolve: {
    // Some more replacements for node dependencies
    alias: {
      // maps fs to a virtual one allowing to register file content dynamically
      fs: '@foliojs-fork/pdfkit/js/virtual-fs.js',
      // iconv-lite is used to load cid less fonts (not spec compliant)
      'iconv-lite': false,
    },
    extensions: ['.js', '.ts'],
    // And more replacements for node dependencies
    fallback: {
      // crypto module is not necessary in browser
      crypto: false,
      buffer: require.resolve('buffer/'),
      stream: require.resolve('readable-stream'),
      zlib: require.resolve('browserify-zlib'),
      util: require.resolve('util/'),
      assert: require.resolve('assert/'),
      events: require.resolve('events/'),
    },
    mainFields: ['browser', 'module', 'main'],
  },
  output: {
    // TODO: Fix this up
    path: path.resolve(__dirname, '../dist/'),
    filename: 'pdiiif-lib-web.js',
    libraryTarget: 'umd',
    library: 'pdiiif',
    umdNamedDefine: true
  },
  module: {
    rules: [
      // Rule: TypeScript
      { test: /\.ts$/, use: 'ts-loader', exclude: [/node_modules/,/__tests__/] },
      // fontkit: bundle and load afm files verbatim
      { test: /\.afm$/, type: 'asset/source' },
      // pdfkit: convert to base64 and include inline file system binary files used by fontkit and linebreak
      {
        enforce: 'post',
        test: /fontkit[/\\]index.js$/,
        loader: 'transform-loader',
        options: {
          brfs: {},
        },
      },
      {
        enforce: 'post',
        test: /linebreak[/\\]src[/\\]linebreaker.js/,
        loader: 'transform-loader',
        options: {
          brfs: {},
        },
      },
    ],
  },
  target: isDevelopment ? 'web' : 'browserslist',
  devtool: isProduction && 'source-map',
  stats: {
    chunks: false,
    chunkModules: false,
    modules: true,
    assets: true,
    entrypoints: true,
  },
};

// Configuration for production bundles
if (isProduction) {
  config.plugins?.push(new CleanWebpackPlugin());

  // Minify and treeshake JS
  if (config.optimization === undefined) {
    config.optimization = {};
  }

  config.optimization.minimize = true;
}

export default config;
