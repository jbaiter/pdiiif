<script lang="ts">
  import { _ } from 'svelte-i18n';

  import type { ManifestInfo } from './iiif';
  import Spinner from './Spinner.svelte';

  export let infoPromise: Promise<ManifestInfo | void>;
  export let estimatePromise: Promise<number> | undefined;
  export let canvasIdentifiers: string[] | undefined;
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
        <ul class="mt-4">
          <li>
            {canvasIdentifiers?.length || manifestInfo.canvasIds.length}
            {$_('number_of_pages')}
          </li>
          {#if estimatePromise}
            <li>
              {$_('estimated_pdf_size')}:
              {#await estimatePromise}
                <Spinner />
              {:then size}
                <strong>{(size / 1024 / 1024).toFixed(2)} MiB</strong>
              {:catch}
                <strong>{$_('errors.estimate_failure')}</strong>
              {/await}
            </li>
          {/if}
        </ul>
      </div>
    {/if}
  {/await}
</div>
