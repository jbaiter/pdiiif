<script lang="ts">
  import { _ } from 'svelte-i18n';

  import type { ManifestInfo } from './iiif';

  export let manifestInfo: ManifestInfo;
  export let scaleFactor: number;
  export let disabled = false;

  let maxWidthPct = 100;
  let showSettings = false;

  $: settingsAvailable = manifestInfo.supportsDownscale;
  $: showSettings = showSettings && !disabled;
</script>

{#if settingsAvailable}
  <div class="mt-4 w-full flex justify-end">
    {#if showSettings}
      <div class="bg-green-200 p-2 rounded-md w-full">
        <button
          class="float-right flex items-center justify-center w-6 h-6 bg-gray-200 rounded-full"
          type="button"
          {disabled}
          on:click={() => {
            showSettings = false;
          }}>×</button
        >
        {#if manifestInfo.supportsDownscale}
          <label class="block">
            {$_('settings.img_width')}
            <input
              type="range"
              name="max-img-width"
              min="10"
              max="100"
              step="10"
              on:change={() => {
                scaleFactor = maxWidthPct / 100;
              }}
              bind:value={maxWidthPct}
            />
            <span class="ml-2">{maxWidthPct}%</span>
          </label>
        {/if}
      </div>
    {:else}
      <button
        type="button"
        class="bg-green-200 disabled:bg-gray-500 rounded-lg items-center p-1 text-gray-700"
        title={$_('buttons.settings')}
        {disabled}
        on:click={() => {
          showSettings = true;
        }}
      >
        <svg
          class="inline align-text-top w-4 h-4 mx-2 fill-current"
          viewBox="0 0 21 21"
          aria-hidden="true"
          ><path
            d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
          /></svg
        ><span class="sr-only">{$_('buttons.settings')}</span></button
      >
    {/if}
  </div>
{/if}
