<script lang="ts">
  import { _ } from 'svelte-i18n';

  import QualityPreview from './QualityPreview.svelte';
  import type { ManifestInfo } from './iiif';
  import type { Estimation, OptimizationParams } from 'pdiiif';

  export let manifestInfo: ManifestInfo;
  export let scaleFactor: number;
  export let canvasIdentifiers: string[] | undefined;
  export let disabled = false;
  export let estimatePromise: Promise<Estimation> | undefined;
  export let optimizationConfig: OptimizationParams | undefined;

  let previewImageData: Uint8Array | undefined;
  let previewImageMimeType: string | undefined;
  let waitingForPreviewUpdate = false;

  let maxWidthPct = 100;
  let showSettings = false;
  let canvasRangeValidationError: string | undefined = undefined;

  $: showSettings = showSettings && !disabled;

  $: if (optimizationConfig) {
    waitingForPreviewUpdate = true;
  }

  $: if (estimatePromise) {
    waitingForPreviewUpdate = true;
    estimatePromise.then((estimation) => {
      previewImageData = estimation.sampleImageData;
      previewImageMimeType = estimation.sampleImageMimeType;
      waitingForPreviewUpdate = false;
    });
  }

  function range(start: number, end: number): number[] {
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }

  function onCanvasRangeChange({
    currentTarget,
  }: {
    currentTarget: EventTarget;
  }) {
    const indexSpec = (currentTarget as HTMLInputElement).value;
    try {
      canvasIdentifiers = parseCanvasRanges(indexSpec);
    } catch (err: any) {
      canvasRangeValidationError = err.message;
    }
  }

  function parseCanvasRanges(indexSpec: string): string[] | undefined {
    const canvasCount = manifestInfo.canvasIds.length;
    const canvasIdxs = new Set(
      indexSpec
        .split(',')
        .filter((g) => g.length > 0)
        .reduce((idxs: number[], group: string) => {
          let newIdxs: number[];
          if (group.startsWith('-')) {
            const end = Number.parseInt(group.slice(1));
            if (end < 1 || end > manifestInfo.canvasIds.length) {
              throw new Error(
                $_('errors.invalid_canvas_range_bad_index', {
                  values: { range: group, canvasCount },
                })
              );
            }
            newIdxs = range(1, end);
          } else if (group.endsWith('-')) {
            const start = Number.parseInt(group.slice(0, -1));
            if (start < 1 || start > manifestInfo.canvasIds.length) {
              throw new Error(
                $_('errors.invalid_canvas_range_bad_index', {
                  values: { range: group, canvasCount },
                })
              );
            }
            newIdxs = range(start, manifestInfo.canvasIds.length);
          } else if (group.indexOf('-') > 0) {
            const parts = group.split('-');
            const [start, end] = parts.map((p) => Number.parseInt(p, 10));
            if (
              start < 1 ||
              end < 1 ||
              start > end ||
              start > manifestInfo.canvasIds.length ||
              end > manifestInfo.canvasIds.length
            ) {
              throw new Error(
                $_('errors.invalid_canvas_range_bad_index', {
                  values: { range: group, canvasCount },
                })
              );
            }
            newIdxs = range(
              Number.parseInt(parts[0]),
              Number.parseInt(parts[1])
            );
          } else {
            const num = Number.parseInt(group);
            if (num < 1 || num > manifestInfo.canvasIds.length) {
              throw new Error(
                $_('errors.invalid_canvas_range_bad_index', {
                  values: { range: group, canvasCount },
                })
              );
            }
            newIdxs = [num];
          }
          if (newIdxs.find(Number.isNaN)) {
            throw new Error(
              $_('errors.invalid_canvas_range', {
                values: { range: group, canvasCount },
              })
            );
          }
          return idxs.concat(newIdxs);
        }, [])
    );
    const out = manifestInfo.canvasIds.filter((_, i) => canvasIdxs.has(i + 1));
    if (out.length === 0) {
      return undefined;
    }
    return out;
  }
</script>

<div class="mt-4 w-full flex justify-end h-full">
  <div
    class="bg-green-200 p-2 rounded-md w-full h-full {showSettings
      ? ''
      : 'hidden'}"
  >
    <button
      class="float-right flex items-center justify-center w-6 h-6 bg-gray-200 rounded-full"
      type="button"
      {disabled}
      on:click={() => {
        showSettings = false;
      }}>×</button
    >
    {#if manifestInfo.supportsDownscale}
      <label class="flex mt-2">
        <span class="w-32">
          {$_('settings.img_width')}
        </span>
        <input
          class="flex-grow"
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
        <span class="ml-2 mr-8">{maxWidthPct}%</span>
      </label>
    {/if}
    <label class="flex mb-2 mt-4">
      <span class="w-32">
        {$_('settings.canvases')}
      </span>
      <input
        class="flex-grow mr-12"
        type="text"
        name="canvases"
        on:change={onCanvasRangeChange}
        placeholder="1, 4, 8-12, ..."
      />
      {#if canvasRangeValidationError}
        <span class="block text-red-500">{canvasRangeValidationError}</span>
      {/if}
    </label>
    <label class="flex mb-2 mt-4">
      <span class="w-32">
        {$_('settings.optimization')}
      </span>
      <select
        class="flex-grow"
        name="optimization-type"
        on:change={({ currentTarget }) => {
          if (currentTarget.value === 'null') {
            optimizationConfig = undefined;
            return;
          }
          optimizationConfig = {
            // @ts-ignore
            method: currentTarget.value,
            quality: 75,
          };
        }}
      >
        <option value="null">{$_('settings.optimization_none')}</option>
        <option value="mozjpeg">
          {$_('settings.optimization_mozjpeg')}
        </option>
        <option value="browser">
          {$_('settings.optimization_browser')}
        </option>
      </select>
    </label>
    {#if optimizationConfig}
      <label class="flex mb-2 mt-4">
        <span class="w-32">
          {$_('settings.quality')}
        </span>
        <input
          class="flex-grow"
          type="range"
          name="quality"
          min="1"
          max="100"
          step="1"
          bind:value={optimizationConfig.quality}
        />
        <span class="ml-2 mr-8">{optimizationConfig?.quality}</span>
      </label>
      {#if previewImageData && previewImageMimeType}
        <QualityPreview
          imageData={previewImageData}
          mimeType={previewImageMimeType}
          waitingForUpdate={waitingForPreviewUpdate}
        />
      {/if}
    {/if}
  </div>
  <button
    type="button"
    class="bg-green-200 disabled:bg-gray-500 rounded-lg items-center p-2 text-gray-700 {showSettings
      ? 'hidden'
      : ''}"
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
</div>
