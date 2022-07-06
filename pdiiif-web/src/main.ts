import { addMessages, init, getLocaleFromNavigator } from 'svelte-i18n';
import App from './App.svelte';
import de from '../locales/de.json';
import en from '../locales/en.json';
import { setLogger, ConsoleLogger } from 'pdiiif';

interface Options {
  apiEndpoint: string;
  coverPageEndpoint?: string;
}

export function render(
  target: HTMLElement,
  { apiEndpoint, coverPageEndpoint }: Options
): App {
  setLogger(new ConsoleLogger(import.meta.env.DEV ? 'debug' : 'warn'));
  addMessages('de', de);
  addMessages('en', en);
  init({
    fallbackLocale: 'en',
    initialLocale: getLocaleFromNavigator(),
  });

  return new App({
    props: { apiEndpoint, coverPageEndpoint },
    target,
  });
}

if (import.meta.env.CFG_SENTRY_DSN) {
  Promise.all([import('@sentry/browser'), import('@sentry/tracing')]).then(
    ([Sentry, Tracing]) => {
      Sentry.init({
        dsn: import.meta.env.CFG_SENTRY_DSN as string,
        integrations: [new Tracing.Integrations.BrowserTracing()],
        tracesSampleRate: 1.0,
      });
    }
  );
  import('@sentry/browser').then((Sentry) => {});
}

let apiEndpoint = import.meta.env.CFG_API_ENDPOINT as string;
if (!apiEndpoint) {
  apiEndpoint = import.meta.env.DEV
    ? 'http://localhost:31337/api'
    : `${window.location.toString().replace(/\/$/g, '')}/api`;
}

render(document.getElementById('app'), {
  apiEndpoint,
});
