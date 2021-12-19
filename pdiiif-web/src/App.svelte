<script lang="ts">
  /// <reference types="wicg-file-system-access"/>
  import { convertManifest, ProgressStatus, CancelToken } from 'pdiiif';

  import type { ManifestInfo } from './iiif';
  import { fetchManifestInfo } from './iiif';
  import Preview from './Preview.svelte';
  import Settings from './Settings.svelte';

  import logoSvgUrl from '../assets/logo.svg';

  export let apiEndpoint: string = 'http://localhost:31337/api';
  export let coverPageEndpoint: string = `${apiEndpoint}/coverpage`;

  let manifestUrl: string = '';
  let manifestUrlIsValid: boolean | undefined;
  let pdfFinished: boolean | undefined;
  let errorMessage: string | undefined = undefined;
  let infoMessage: string | undefined = undefined;
  let currentProgress: ProgressStatus | undefined;

  // Only relevant for client-side generation
  let pdfPath: string | undefined;
  let cancelToken: CancelToken | undefined;
  let cancelRequested = false;
  let cancelled = false;
  let manifestInfo: ManifestInfo | undefined;
  let infoPromise: Promise<ManifestInfo | void> | undefined;
  let maxWidth: number | undefined;

  $: progressPercent = currentProgress
    ? (currentProgress.bytesWritten /
        (currentProgress.estimatedFileSize ?? Number.MAX_SAFE_INTEGER)) *
      100
    : undefined;
  $: progressStyle = currentProgress ? `width: ${progressPercent}%` : undefined;
  $: if (manifestUrl && manifestUrlIsValid) {
    infoPromise = fetchManifestInfo(manifestUrl).then((info) => {
      maxWidth = info.maximumImageWidth;
      manifestInfo = info;
      return info;
    }).catch((err) => {
      errorMessage = `Could not fetch manifest: ${err}`;
      infoPromise = undefined;
    });
  }

  $: if (manifestUrl.length === 0) {
    resetState();
  }

  function resetState() {
    manifestUrl = '';
    pdfPath = undefined;
    currentProgress = undefined;
    errorMessage = undefined;
    infoMessage = undefined;
    pdfFinished = undefined;
    cancelRequested = false;
    cancelled = false;
    manifestInfo = undefined;
    infoPromise = undefined;
    maxWidth = undefined;
  }

  /// Simply generate a random hex string
  function generateProgressToken() {
    if (typeof window.crypto !== 'undefined') {
      const buf = new Uint32Array(2);
      crypto.getRandomValues(buf);
      return buf[0].toString(16) + buf[1].toString(16);
    } else {
      return Math.floor(Math.random() * 10e16).toString(16);
    }
  }

  /// Generate a PDF completely on the client side, using the
  /// File System Access API available in newer WebKit browsers
  async function generatePdfClientSide(): Promise<void> {
    let manifestResp: Response;
    try {
      manifestResp = await fetch(manifestUrl);
    } catch (err) {
      errorMessage = `Failed to fetch manifest from ${manifestUrl}: ${err}`;
      return;
    }
    const manifestJson = await manifestResp.json();

    // TODO: make i18n-safe!
    let cleanLabel = manifestJson.label.substring(0, 200); // Limit file name length
    if (cleanLabel.endsWith('.')) {
      // Prevent duplicate period characters in filename
      cleanLabel = cleanLabel.substring(0, cleanLabel.length - 1);
    }

    const handle = await showSaveFilePicker({
      // @ts-ignore, only available in Chrome >= 91
      suggestedName: `${cleanLabel}.pdf`,
      types: [
        {
          description: 'PDF file',
          accept: { 'application/pdf': ['.pdf'] },
        },
      ],
    });
    if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      errorMessage = `no permission to write to '${handle.name}'`;
      return;
    }
    pdfPath = (await handle.getFile()).name;
    const webWritable = await handle.createWritable();
    cancelToken = new CancelToken();
    cancelToken.addOnCancelled(async () => {
      await webWritable.abort();
      cancelled = true;
    });
    try {
      await convertManifest(manifestJson, webWritable, {
        concurrency: 4,
        languagePreference: window.navigator.languages,
        onProgress: (status) => {
          currentProgress = status;
        },
        cancelToken,
        coverPageEndpoint,
        maxWidth,
      });
    } catch (err) {
      errorMessage = `Failed to generate PDF: ${err}`;
      await webWritable.abort();
    } finally {
      cancelToken = undefined;
    }
  }

  /// Let some backend server generate the PDF and stream it to us
  /// Intended for Firefox and older browsers that don't support the
  /// File System Access API
  async function generatePdfServerSide(): Promise<void> {
    const pdfEndpoint = `${apiEndpoint}/generate-pdf`;
    const progressToken = generateProgressToken();
    const progressEndpoint = `${apiEndpoint}/progress/${progressToken}`;
    const progressSource = new EventSource(progressEndpoint, {
      withCredentials: true,
    });
    progressSource.addEventListener('error', (msg) => {
      if (pdfFinished) {
        return;
      }
      progressSource.close();
      currentProgress = undefined;
      cancelled = true;
      errorMessage = `Failed to generate PDF: "${progressEndpoint}"`;
    });
    const promise: Promise<void> = new Promise((resolve) =>
      progressSource.addEventListener('progress', (evt) => {
        currentProgress = JSON.parse((evt as any).data);
        const isDone =
          currentProgress.pagesWritten === currentProgress.totalPages &&
          currentProgress.bytesPushed === currentProgress.estimatedFileSize;
        if (isDone) {
          progressSource.close();
          resolve();
        }
      })
    );
    window.open(
      `${pdfEndpoint}?${new URLSearchParams({ manifestUrl, progressToken })}`
    );
    await promise;
  }

  async function generatePdf(evt: Event): Promise<void> {
    evt.preventDefault();
    pdfFinished = false;
    let promise: Promise<void>;
    if (typeof window.showSaveFilePicker === 'function') {
      promise = generatePdfClientSide();
    } else {
      promise = generatePdfServerSide();
    }
    await promise;
    infoMessage = `PDF successfully generated.`;
    pdfFinished = true;
  }

  async function cancelGeneration(): Promise<void> {
    cancelRequested = true;
    await cancelToken.requestCancel();
    infoMessage = `PDF generation cancelled.`;
  }
</script>

<div class="w-full md:w-1/2">
  <img
    src={logoSvgUrl}
    alt="pdiiif logo"
    class="w-24 mx-auto mb-4 filter drop-shadow-lg"
  />
  {#if infoMessage}
    <div
      class="flex items-center bg-green-600 rounded-lg mb-2 text-white text-sm font-bold px-4 py-3"
      role="alert"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-5 w-5 mr-2"
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
          clip-rule="evenodd"
        />
      </svg>
      <p>{infoMessage}</p>
    </div>
  {/if}
  {#if errorMessage}
    <div
      class="flex items-center bg-red-600 rounded-lg mb-2 text-white text-sm font-bold px-4 py-3"
      role="alert"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-5 w-5 mr-2"
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
          clip-rule="evenodd"
        />
      </svg>
      <p>{errorMessage}</p>
    </div>
  {/if}
  <div class="flex flex-col bg-blue-400 m-auto p-4 rounded-md shadow-lg">
    <form on:submit={generatePdf}>
      {#if infoPromise}
        <Preview {manifestUrl} {maxWidth} {infoPromise} />
      {/if}
      <div class="relative text-gray-700 mt-4">
        <input
          class="w-full h-10 pl-3 pr-10 text-base placeholder-gray-600 border rounded-lg focus:shadow-outline"
          type="url"
          placeholder="Manifest URL"
          name="manifest-url"
          disabled={currentProgress !== undefined && !pdfFinished}
          bind:value={manifestUrl}
          on:input={(evt) => {
            const inp = evt.target;
            if (inp.validity.typeMisMatch || inp.validity.patternMismatch) {
              manifestUrlIsValid = false;
              errorMessage = inp.validationMessage;
            } else {
              manifestUrlIsValid = true;
              errorMessage = undefined;
            }
          }}
          on:focus={() => {
            if (pdfFinished || cancelled) {
              resetState();
            }
          }}
        />
        <button
          type="submit"
          disabled={manifestUrl.length === 0 ||
            (currentProgress && !pdfFinished)}
          class="absolute inset-y-0 right-0 flex items-center px-1 font-bold text-white disabled:opacity-25 bg-indigo-600 rounded-r-lg hover:bg-indigo-500 focus:bg-indigo-700"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            class="w-7 h-7 fill-current"
          >
            <title>Generate PDF</title>
            <path
              d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z"
            />
          </svg>
        </button>
      </div>
      {#if manifestInfo}
        <Settings bind:maxWidth {manifestInfo} />
      {/if}
    </form>
    {#if currentProgress && !pdfFinished && !cancelled}
      <div class="relative mt-4 h-8 w-full bg-gray-300">
        <div style={progressStyle} class="h-full bg-blue-600" />
        {#if currentProgress.estimatedFileSize}
          <div
            class="absolute w-full top-0 pt-1 text-center text-white mix-blend-difference"
          >
            {(currentProgress.bytesWritten / (1024 * 1024)).toFixed(1)}MiB / ~{(
              currentProgress.estimatedFileSize /
              (1024 * 1024)
            ).toFixed(1)}MiB ({(
              currentProgress.writeSpeed /
              (1024 * 1024)
            ).toFixed(1)}MiB/s)
          </div>
        {/if}
      </div>
      {#if cancelToken && !cancelled}
        <button
          class="mx-auto mt-2 px-2 py-1 font-bold text-white disabled:opacity-25 bg-red-600 rounded-lg hover:bg-red-500 focus:bg-red-700"
          on:click={cancelGeneration}
          disabled={cancelRequested}
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            class="inline h-7 fill-current"
            ><path
              d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"
            /></svg
          >
          Cancel PDF generation
        </button>
      {/if}
    {/if}
  </div>
</div>

<style global lang="postcss">
  @tailwind base;
  @tailwind components;
  @tailwind utilities;
</style>
