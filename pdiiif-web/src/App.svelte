<script lang="ts">
  /// <reference types="wicg-file-system-access"/>
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { without } from 'lodash';
  import { convertManifest, ProgressStatus, CancelToken } from 'pdiiif';

  import type { ManifestInfo } from './iiif';
  import { fetchManifestInfo } from './iiif';
  import Preview from './Preview.svelte';
  import Settings from './Settings.svelte';
  import Notification from './Notification.svelte';

  import logoSvgUrl from '../assets/logo.svg';

  export let apiEndpoint: string = 'http://localhost:31337/api';
  export let coverPageEndpoint: string = `${apiEndpoint}/coverpage`;

  let manifestUrl: string = '';
  let manifestUrlIsValid: boolean | undefined;
  let pdfFinished: boolean | undefined;
  let currentProgress: ProgressStatus | undefined;
  let notifications: Array<NotificationMessage> = [];
  const supportsClientSideGeneration =
    typeof window.showSaveFilePicker === 'function';

  // Only relevant for client-side generation
  let cancelToken: CancelToken | undefined;
  let cancelRequested = false;
  let cancelled = false;
  let manifestInfo: ManifestInfo | undefined;
  let infoPromise: Promise<ManifestInfo | void> | undefined;
  let scaleFactor = 1;

  $: progressPercent = currentProgress
    ? (currentProgress.bytesWritten /
        (currentProgress.estimatedFileSize ?? Number.MAX_SAFE_INTEGER)) *
      100
    : undefined;
  $: progressStyle = currentProgress ? `width: ${progressPercent}%` : undefined;
  $: if (manifestUrl && manifestUrlIsValid && !infoPromise) {
    infoPromise = fetchManifestInfo(manifestUrl)
      .then((info) => {
        manifestInfo = info;
        if (supportsClientSideGeneration && !manifestInfo.imageApiHasCors) {
          notifications.push({
            type: 'warn',
            message: $_('errors.cors'),
          });
        }
        return info;
      })
      .catch((err) => {
        addNotification({
          type: 'error',
          message: $_('errors.manifest_fetch', {
            values: { manifestUrl, errorMsg: err.message },
          }),
        });
        infoPromise = undefined;
      });
  }

  $: if (manifestUrl.length === 0) {
    resetState();
  }

  onMount(async () => {
    if (!supportsClientSideGeneration) {
      addNotification({
        type: 'warn',
        message: $_('errors.no_clientside'),
      });
    }
  });

  function resetState() {
    manifestUrl = '';
    currentProgress = undefined;
    pdfFinished = undefined;
    cancelRequested = false;
    cancelled = false;
    manifestInfo = undefined;
    infoPromise = undefined;
    scaleFactor = 1;
  }

  function addNotification(msg: NotificationMessage): void {
    notifications = [msg, ...notifications.slice(0, 4)];
  }

  function clearNotifications(tag?: string) {
    if (tag !== undefined) {
      notifications = notifications.filter(
        (n) => n.tags == undefined || n.tags.indexOf(tag) < 0
      );
    } else {
      notifications = [];
    }
  }

  const onManifestInput: svelte.JSX.FormEventHandler<HTMLInputElement> = (evt) => {
    const inp = evt.target as HTMLInputElement;
    clearNotifications('validation');
    if (inp.validity.typeMismatch || inp.validity.patternMismatch) {
      manifestUrlIsValid = false;
      addNotification({
        type: 'error',
        message: inp.validationMessage,
        tags: ['validation'],
      });
    } else {
      manifestUrlIsValid = true;
      // FIXME: Meh, shouldn't we have a separate state variable for validation messages?
      clearNotifications('validation');
    }
  };

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
      addNotification({
        type: 'error',
        message: $_('errors.manifest_fetch', {
          values: { manifestUrl, errorMsg: err.message },
        }),
      });
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
      addNotification({
        type: 'error',
        message: $_('errors.write_perm', { values: { fileName: handle.name } }),
      });
    }
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
        scaleFactor,
      });
    } catch (err) {
      addNotification({
        type: 'error',
        message: $_('errors.pdf_failure_', {
          values: { errorMsg: err.message },
        }),
      });
      currentProgress = undefined;
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
    const progressSource = new EventSource(progressEndpoint);
    progressSource.addEventListener('error', () => {
      progressSource.close();
      currentProgress = undefined;
      cancelled = true;
      addNotification({
        type: 'error',
        message: $_('errors.pdf_failure_conn', { values: { apiEndpoint } }),
      });
    });
    progressSource.addEventListener('servererror', (evt) => {
      if (pdfFinished) {
        return;
      }
      progressSource.close();
      currentProgress = undefined;
      cancelled = true;
      addNotification({
        type: 'error',
        message: $_('errors.pdf_failure', {
          values: { errorMsg: (evt as any).data },
        }),
      });
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
    pdfFinished = true;
  }

  async function generatePdf(evt: Event): Promise<void> {
    evt.preventDefault();
    pdfFinished = false;
    let promise: Promise<void>;
    if (supportsClientSideGeneration && manifestInfo.imageApiHasCors) {
      promise = generatePdfClientSide();
    } else {
      promise = generatePdfServerSide();
    }
    await promise;
    addNotification({
      type: 'success',
      message: $_('notifications.success'),
    });
    pdfFinished = true;
  }

  async function cancelGeneration(): Promise<void> {
    cancelRequested = true;
    await cancelToken.requestCancel();
    addNotification({
      type: 'info',
      message: $_('notifications.cancel'),
    });
  }
</script>

<div class="w-full md:w-1/2">
  <img
    src={logoSvgUrl}
    alt="pdiiif logo"
    class="w-24 mx-auto mb-4 filter drop-shadow-lg"
  />
  <div>
    {#each notifications as notification}
      <Notification
        type={notification.type}
        on:close={() => {
          if (notification.type === 'success') {
            resetState();
          }
          notifications = without(notifications, notification);
        }}
      >
        {notification.message}
      </Notification>
    {/each}
  </div>
  <div class="flex flex-col bg-blue-400 m-auto p-4 rounded-md shadow-lg">
    <form on:submit={generatePdf}>
      {#if infoPromise}
        <Preview {scaleFactor} {infoPromise} />
      {/if}
      <div class="relative text-gray-700 mt-4">
        <input
          class="w-full h-10 pl-3 pr-10 text-base placeholder-gray-600 border rounded-lg focus:shadow-outline"
          type="url"
          placeholder="Manifest URL"
          name="manifest-url"
          disabled={currentProgress !== undefined && !pdfFinished}
          bind:value={manifestUrl}
          on:input={onManifestInput}
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
            <title>{$_('buttons.generate')}</title>
            <path
              d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z"
            />
          </svg>
        </button>
      </div>
      {#if manifestInfo}
        <Settings bind:scaleFactor {manifestInfo} disabled={!!currentProgress} />
      {/if}
    </form>
    {#if currentProgress && !pdfFinished && !cancelled}
      <div
        class="relative mt-4 h-8 w-full rounded-md bg-gray-300 border-2 border-white"
      >
        <div style={progressStyle} class="h-full rounded-md bg-blue-600" />
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
          {$_('buttons.cancel')}
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
