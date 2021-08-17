import { addMessages, init, getLocaleFromNavigator } from "svelte-i18n";

import App from "./App.svelte";
import de from "../locales/de.json";
import en from "../locales/en.json";

interface Options {
  apiEndpoint: string | undefined;
}

function render(target: HTMLElement, { apiEndpoint }: Options): App {
  addMessages("de", de);
  addMessages("en", en);
  init({
    fallbackLocale: "en",
    initialLocale: getLocaleFromNavigator(),
  });

  return new App({
    props: { apiEndpoint },
    target
  });
}

export default { render };
