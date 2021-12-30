<script lang="ts">
  import { _ } from 'svelte-i18n';
  import { estimatePdfSize } from 'pdiiif';

  import type { ManifestInfo } from './iiif';
  import Spinner from './Spinner.svelte';

  export let maxWidth: number | undefined;
  export let infoPromise: Promise<ManifestInfo | void>;

  async function getFileSizeEstimate(
    manifestInfo: ManifestInfo,
    maxWidth: number | undefined
  ): Promise<number> {
    return await estimatePdfSize({
      manifestJson: manifestInfo.manifestJson,
      concurrency: 4,
      maxWidth,
      numSamples: 8,
    });
  }
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
        {#if manifestInfo.imageApiHasCors}
        <p class="mt-4">
          {$_('estimated_pdf_size')}:
          {#await getFileSizeEstimate(manifestInfo, maxWidth)}
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
