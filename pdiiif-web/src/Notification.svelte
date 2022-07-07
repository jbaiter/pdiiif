<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Error from './icons/Error.svelte';
  import Info from './icons/Info.svelte';
  import Close from './icons/Close.svelte';

  export let type: 'success' | 'error' | 'info' | 'warn';
  export let choices: { [labelKey: string]: () => void } | undefined =
    undefined;

  $: colorClass = {
    success: 'bg-green-600',
    error: 'bg-red-600',
    info: 'bg-blue-600',
    warn: 'bg-orange-500',
  }[type];

  $: Icon = {
    success: Info,
    error: Error,
    info: Info,
    warn: Error,
  }[type];

  const dispatch = createEventDispatcher();
</script>

<div
  class="flex items-start {colorClass} rounded-lg mb-2 text-white text-sm font-bold px-4 py-3"
  role="alert"
>
  <div>
    <svelte:component this={Icon} classes="h-4 w-4 mr-2" />
  </div>
  <div class="flex-grow">
    <p class="flex-grow overflow-auto" style="hyphens: auto;"><slot /></p>
    {#if choices}
      <div class="flex items-center mt-4">
        {#each Object.entries(choices) as [labelKey, action]}
          <button
            class="px-2 py-1 mr-2 border border-blue-400 bg-white rounded-lg hover:border-green-400 text-black hover:font-bold"
            on:click={() => {
              action();
              dispatch('close');
            }}
          >
            {$_(labelKey)}
          </button>
        {/each}
      </div>
    {/if}
  </div>
  <button title={$_('buttons.close')} on:click={() => dispatch('close')}>
    <Close classes="h-4 w-4" />
  </button>
</div>
