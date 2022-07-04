import { addMessages, init, getLocaleFromNavigator } from 'svelte-i18n';
import * as Sentry from "@sentry/browser";
import { Integrations } from "@sentry/tracing";

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
  setLogger(new ConsoleLogger(import.meta.env.DEV ? 'debug' : 'warn'))
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

if (import.meta.env.PDIIIF_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.PDIIIF_SENTRY_DSN as string,
    integrations: [new Integrations.BrowserTracing()],
    tracesSampleRate: 1.0,
  });
}

render(document.getElementById('app'), {
  apiEndpoint: import.meta.env.DEV
    ? 'http://localhost:31337/api'
    : `${window.location.toString().replace(/\/$/g, '')}/api`,
});
