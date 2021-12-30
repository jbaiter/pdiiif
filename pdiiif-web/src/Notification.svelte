<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Error from './icons/Error.svelte';
  import Info from './icons/Info.svelte';
  import Close from './icons/Close.svelte';

  export let type: 'success' | 'error' | 'info' | 'warn';

  $: colorClass = {
    'success': 'bg-green-600',
    'error': 'bg-red-600',
    'info': 'bg-blue-600',
    'warn': 'bg-orange-500',
  }[type]

  $: Icon = {
    'success': Info,
    'error': Error,
    'info': Info,
    'warn': Error,
  }[type]

  const dispatch = createEventDispatcher();
</script>


<div
  class="flex items-start {colorClass} rounded-lg mb-2 text-white text-sm font-bold px-4 py-3"
  role="alert"
>
  <svelte:component this={Icon} classes="h-12 w-12 mr-2 flex-grow" />
  <p class="flex-grow"><slot /></p>
  <button
    title="{$_('buttons.close')}"
    on:click={() => dispatch('close')}
  >
    <Close />
  </button>
</div>
