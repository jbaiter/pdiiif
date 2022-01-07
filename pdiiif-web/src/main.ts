import { addMessages, init, getLocaleFromNavigator } from 'svelte-i18n';

import App from './App.svelte';
import de from '../locales/de.json';
import en from '../locales/en.json';

interface Options {
  apiEndpoint: string;
  coverPageEndpoint?: string;
}

export function render(
  target: HTMLElement,
  { apiEndpoint, coverPageEndpoint }: Options
): App {
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

render(document.getElementById('app'), {
  apiEndpoint: import.meta.env.DEV
    ? 'http://localhost:31337/api'
    : `${window.location.toString().replace(/\/$/g, '')}/api`,
});
