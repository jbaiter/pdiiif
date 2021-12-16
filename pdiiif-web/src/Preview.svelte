<script lang="ts">
  import { estimatePdfSize } from 'pdiiif';

  import type { ManifestInfo } from './iiif';
  import Spinner from './Spinner.svelte';

  export let manifestUrl: string;
  export let maxWidth: number | undefined;
  export let infoPromise: Promise<ManifestInfo>;

  async function getFileSizeEstimate(
    manifestInfo: ManifestInfo,
    maxWidth: number | undefined,
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
    <img
      src={manifestInfo.previewImageUrl}
      alt="preview"
      class="inline w-32 mr-8 object-scale-down"
    />
    <div>
      <h2 class="font-bold text-lg mt-4">{manifestInfo.label}</h2>
      <p class="mt-4">
        Estimated PDF size:
        {#await getFileSizeEstimate(manifestInfo, maxWidth)}
          <Spinner />
        {:then size}
          <strong>{(size / 1024 / 1024).toFixed(2)} MiB</strong>
        {:catch}
          <strong>Failed to load size estimatePromise.</strong>
        {/await}
      </p>
    </div>
  {:catch err}
    <div>Failed to load Manifest from {manifestUrl}: {err}</div>
  {/await}
</div>
