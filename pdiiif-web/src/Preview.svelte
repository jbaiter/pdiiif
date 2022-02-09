<script lang="ts">
  import { _ } from 'svelte-i18n';

  import type { ManifestInfo } from './iiif';
  import Spinner from './Spinner.svelte';

  export let infoPromise: Promise<ManifestInfo | void>;
  export let estimatePromise: Promise<number> | undefined;
</script>

<div class="flex bg-indigo-100 p-2 rounded-md mb-4">
  {#await infoPromise}
    <Spinner />
  {:then manifestInfo}
    {#if manifestInfo}
      <img
        src={manifestInfo.previewImageUrl}
        alt="preview"
        class="inline w-32 mr-8 object-scale-down"
      />
      <div>
        <h2 class="font-bold text-lg mt-4">{manifestInfo.label}</h2>
        {#if estimatePromise}
        <p class="mt-4">
          {$_('estimated_pdf_size')}:
          {#await estimatePromise}
            <Spinner />
          {:then size}
            <strong>{(size / 1024 / 1024).toFixed(2)} MiB</strong>
          {:catch}
            <strong>{$_('errors.estimate_failure')}</strong>
          {/await}
        </p>
        {/if}
      </div>
    {/if}
  {/await}
</div>
