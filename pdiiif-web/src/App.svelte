<script lang="ts">
  /// <reference types="wicg-file-system-access"/>
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import classNames from 'classnames';
  import {
    convertManifest,
    estimatePdfSize,
    type Estimation,
    type ProgressStatus,
    type ProgressNotification,
    type OptimizationParams,
    type ConvertOptions,
  } from 'pdiiif';
  import { getValue } from '@iiif/helpers';
  import streamSaver from 'streamsaver';

  import { fetchManifestInfo, type ManifestInfo } from './iiif';
  import Preview from './Preview.svelte';
  import Settings from './Settings.svelte';
  import Notification from './Notification.svelte';
  import GitHubIcon from './icons/GitHub.svelte';
  import QuestionIcon from './icons/Question.svelte';

  import logoSvgUrl from '../assets/logo.svg';
  import ErrorIcon from './icons/Exclamation.svelte';
  import ProgressBar from './icons/ProgressBar.svelte';
  import {
    buildCanvasFilterString,
    getMaximumBlobSize,
    supportsStreamsaver,
  } from './util';
  import type { CanvasNormalized } from '@iiif/presentation-3-normalized';

  export let apiEndpoint: string = 'http://localhost:31337/api';
  export let coverPageEndpoint: string = `${apiEndpoint}/coverpage`;
  export let initialManifestUrl: string | null = null;
  export let onError: ((err: Error) => void) | undefined = undefined;

  // We use a self-hosted MITM page for the streamsaver service worker
  // to avoid GDPR issues.
  streamSaver.mitm = `${location.href.replace(
    /\/?(?:\?.*)?$/,
    ''
  )}/streamsaver-mitm.html`;

  const supportsFilesystemAPI = typeof window.showSaveFilePicker === 'function';
  let isFirstVisit = window.localStorage.getItem('firstVisit') === null;

  // Form input state
  let manifestUrl = initialManifestUrl ?? '';
  let scaleFactor = 1;
  let notifyWhenDone = false;
  let canvasIdentifiers: string[] | undefined = undefined;
  let optimizationConfig: OptimizationParams | undefined = undefined;

  // Validation state
  let manifestUrlIsValid: boolean | undefined;

  // Status state
  let pdfFinished: boolean | undefined;
  let currentProgress: ProgressStatus | undefined;
  let notifications: Array<NotificationMessage> = [];

  // External resources
  let manifestInfo: ManifestInfo | undefined;
  let infoPromise: Promise<ManifestInfo | void> | undefined;
  let estimatePromise: Promise<Estimation> | undefined;
  let sampledCanvases: CanvasNormalized[] | undefined;

  // Only relevant for client-side generation
  let abortController: AbortController | undefined;
  let cancelRequested = false;
  let cancelled = false;

  // Only relevant for server-side generation
  let queueState: { current: number; initial: number } | undefined;

  // Ref to manifest input
  let manifestInput: HTMLInputElement | undefined;

  $: if (notifyWhenDone && window.Notification.permission === 'default') {
    window.Notification.requestPermission().then((status) => {
      notifyWhenDone = status === 'granted';
    });
  }

  $: if (manifestUrl && manifestInput) {
    // Updated manifest URL means all old messages are no longer relevant
    clearNotifications();

    if (
      manifestInput.validity.typeMismatch ||
      manifestInput.validity.patternMismatch
    ) {
      manifestUrlIsValid = false;
    } else {
      manifestUrlIsValid = true;
    }
  } else if (manifestInput) {
    resetState();
  }

  $: if (manifestUrlIsValid) {
    scaleFactor;
    canvasIdentifiers;
    optimizationConfig;
    updateEstimate();
  }

  // Show notification if file system api is available
  onMount(async () => {
    if (!isFirstVisit) {
      return;
    }
    const onClose = () => {
      localStorage.setItem('firstVisit', 'false');
      isFirstVisit = false;
    };
    if (supportsFilesystemAPI) {
      addNotification({
        type: 'info',
        message: $_('notifications.filesystem_supported'),
        onClose,
      });
    }
  });

  /** Reset all state variables to their defaults. */
  function resetState() {
    manifestUrl = '';
    manifestUrlIsValid = undefined;
    currentProgress = undefined;
    pdfFinished = undefined;
    cancelRequested = false;
    cancelled = false;
    manifestInfo = undefined;
    infoPromise = undefined;
    estimatePromise = undefined;
    sampledCanvases = undefined;
    scaleFactor = 1;
    optimizationConfig = undefined;
  }

  function updateEstimate() {
    // No async/await, since we need to keep a reference to the promise around
    infoPromise = fetchManifestInfo(manifestUrl)
      .then((info) => {
        manifestInfo = info;
        estimatePromise = estimatePdfSize({
          manifest: manifestInfo.manifest.id,
          filterCanvases: canvasIdentifiers,
          concurrency: 4,
          scaleFactor,
          numSamples: 8,
          optimization: optimizationConfig,
          sampleCanvases: sampledCanvases,
        }).then((estimation) => {
          if (!estimation.corsSupported) {
            // Show a warning if the Image API endpoint does not support CORS
            addNotification({
              type: 'warn',
              message: $_('errors.cors'),
            });
          }
          sampledCanvases = estimation.sampleCanvases;
          return estimation;
        });
        return info;
      })
      .catch((err) => {
        infoPromise = undefined;
        onError?.(err);
        addNotification({
          type: 'error',
          message: $_('errors.manifest_fetch', {
            values: { manifestUrl, errorMsg: err.message },
          }),
          tags: ['validation'],
        });
      });
  }

  /** Show a new notification, making sure no more than 5 are ever shown. */
  function addNotification(msg: NotificationMessage): void {
    if (notifyWhenDone && (msg.type === 'error' || msg.type === 'success')) {
      new window.Notification(msg.message);
    }
    notifications = [msg, ...notifications.slice(0, 4)];
  }

  /** Clear all notifications, optionally filtered by a tag. */
  function clearNotifications(tag?: string) {
    if (tag !== undefined) {
      notifications = notifications.filter(
        (n) => n.tags == undefined || n.tags.indexOf(tag) < 0
      );
    } else {
      notifications = [];
    }
  }

  /// Simply generate a random hex string
  function getRandomToken() {
    if (typeof window.crypto !== 'undefined') {
      const buf = new Uint32Array(2);
      crypto.getRandomValues(buf);
      return buf[0].toString(16) + buf[1].toString(16);
    } else {
      return Math.floor(Math.random() * 10e16).toString(16);
    }
  }

  /// Generate a PDF completely on the client side.
  /// This uses one of three approaches, depending on the browser
  /// and the estimated size of the manifest:
  ///  - File System Access API available in newer WebKit browsers
  ///  - Using StreamSaver.js (simulating a HTTP download via a service worker)
  ///  - Otherwise through a `Blob`, if the manifest is small enough
  async function generatePdfClientSide(): Promise<void> {
    let manifestResp: Response;
    try {
      manifestResp = await fetch(manifestUrl);
    } catch (err) {
      onError?.(err as Error);
      addNotification({
        type: 'error',
        message: $_('errors.manifest_fetch', {
          values: { manifestUrl, errorMsg: (err as Error).message },
        }),
      });
      return;
    }
    const manifestJson = await manifestResp.json();

    let cleanLabel = getValue(manifestInfo!.label).substring(0, 200); // Limit file name length
    if (cleanLabel.endsWith('.')) {
      // Prevent duplicate period characters in filename
      cleanLabel = cleanLabel.substring(0, cleanLabel.length - 1);
    }

    abortController = new AbortController();
    let webWritable: WritableStream<Uint8Array> | undefined;
    if (supportsFilesystemAPI) {
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
          message: $_('errors.write_perm', {
            values: { fileName: handle.name },
          }),
        });
      }
      webWritable = await handle.createWritable();
    } else if (supportsStreamsaver()) {
      webWritable = streamSaver.createWriteStream(`${cleanLabel}.pdf`);
      window.addEventListener('beforeunload', (evt) => {
        if (currentProgress && !cancelled && !pdfFinished) {
          const msg = $_('unload_warning');
          evt.returnValue = msg;
          return msg;
        }
      });
      window.addEventListener(
        'unload',
        () => {
          webWritable?.abort();
        },
        { once: true }
      );
    } else {
      // pdiiif uses a `BlobWriter` if no output stream is provided
      // by the user
    }
    abortController.signal.addEventListener(
      'abort',
      async () => {
        try {
          await webWritable?.abort();
        } catch {
          // NOP
        }
        cancelled = true;
      },
      { once: true }
    );
    try {
      const params: ConvertOptions = {
        filterCanvases: canvasIdentifiers,
        concurrency: 4,
        languagePreference: window.navigator.languages,
        onProgress: (status: ProgressStatus) => {
          currentProgress = status;
        },
        onNotification: (msg: ProgressNotification) => {
          let i18nKey: string = msg.code;
          if (
            msg.code === 'image-download-failure' &&
            msg.numFailed === msg.numTotal
          ) {
            // If all images failed to download, show a different message
            i18nKey = 'image-download-failure-all';
          }
          addNotification({
            type: 'error',
            message: $_(`errors.pdfgen.${i18nKey}`, {
              values: msg as Record<string, string | number>,
            }),
          });
        },
        abortController,
        coverPageEndpoint,
        scaleFactor,
        optimization: optimizationConfig,
        polyglotZipPdf: true,
        polyglotZipBaseDir: cleanLabel,
      };
      if (webWritable === undefined) {
        const res = await convertManifest(manifestJson, webWritable, params);
        const objectURL = URL.createObjectURL(res.data);
        const link = document.createElement('a');
        link.download = `${cleanLabel}.pdf`;
        link.rel = 'noopener';
        link.href = objectURL;
        // Clean up blob/object URL after 40 seconds
        setTimeout(() => URL.revokeObjectURL(objectURL), 40 * 1000);
        link.dispatchEvent(new MouseEvent('click'));
      } else {
        await convertManifest(manifestJson, webWritable, params);
      }
      pdfFinished = true;
    } catch (err) {
      console.error(err);
      onError?.(err as Error);
      addNotification({
        type: 'error',
        message: $_('errors.pdf_failure', {
          values: { errorMsg: (err as Error).message },
        }),
      });
      currentProgress = undefined;
    } finally {
      abortController = undefined;
    }
  }

  /// Let some backend server generate the PDF and stream it to us
  /// Intended for older browsers that don't support neither the File System Access API
  /// nor service workers.
  async function generatePdfServerSide(): Promise<void> {
    const pdfEndpoint = `${apiEndpoint}/generate-pdf`;
    const progressToken = getRandomToken();
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
        queueState = undefined;
        currentProgress = JSON.parse((evt as any).data) as ProgressStatus;
        const isDone =
          currentProgress.pagesWritten === currentProgress.totalPages &&
          currentProgress.bytesPushed === currentProgress.estimatedFileSize;
        if (isDone) {
          progressSource.close();
          resolve();
        }
      })
    );
    progressSource.addEventListener('notification', (evt) => {
      const notification = JSON.parse(
        (evt as any).data
      ) as ProgressNotification;
      let i18nKey: string = notification.code;
      if (
        notification.code === 'image-download-failure' &&
        notification.numFailed === notification.numTotal
      ) {
        // If all images failed to download, show a different message
        i18nKey = 'image-download-failure-all';
      }
      addNotification({
        type: 'error',
        message: $_(`errors.pdfgen.${i18nKey}`, {
          values: notification as Record<string, string | number>,
        }),
      });
    });
    progressSource.addEventListener('queue', (evt) => {
      const queuePosition = JSON.parse((evt as any).data).position;
      if (!queueState) {
        addNotification({
          type: 'info',
          message: $_('notifications.queued', {
            values: { iiifHost: new URL(manifestUrl).host },
          }),
        });
        queueState = { current: queuePosition, initial: queuePosition };
      } else {
        queueState.current = queuePosition;
      }
    });
    const params: Record<string, string> = { manifestUrl, progressToken };
    if (canvasIdentifiers?.length && manifestInfo) {
      const filterString = buildCanvasFilterString(
        manifestInfo.canvasIds,
        canvasIdentifiers
      );
      if (filterString) {
        params.canvasNos = filterString;
      }
    }
    window.open(`${pdfEndpoint}?${new URLSearchParams(params)}`);
    await promise;
    pdfFinished = true;
  }

  async function generatePdf(evt?: Event): Promise<void> {
    evt?.preventDefault();
    pdfFinished = false;
    let promise: Promise<void>;
    let generateOnClient: boolean;
    const { size: sizeEstimate, corsSupported } = (await estimatePromise)!;
    if (!corsSupported) {
      generateOnClient = false;
    } else if (supportsFilesystemAPI || supportsStreamsaver()) {
      generateOnClient = true;
    } else {
      generateOnClient = sizeEstimate <= getMaximumBlobSize();
      if (!generateOnClient) {
        try {
          generateOnClient = await new Promise((resolve, reject) => {
            const tag = getRandomToken();
            addNotification({
              type: 'info',
              message: $_('notifications.large_pdf'),
              choices: {
                'buttons.use_server': () => resolve(false),
                'buttons.force_client': () => resolve(true),
              },
              onClose: () => reject(),
              tags: [tag],
            });
          });
        } catch {
          // User cancelled by closing the notification
          resetState();
          return;
        }
      }
    }

    if (generateOnClient) {
      promise = generatePdfClientSide();
    } else {
      if (corsSupported) {
        addNotification({
          type: 'info',
          message: $_('notifications.server_generation'),
        });
      }
      promise = generatePdfServerSide();
    }
    await promise;
    if (pdfFinished && !cancelled) {
      addNotification({
        type: 'success',
        message: $_('notifications.success'),
        onClose: () => resetState(),
      });
    }
  }

  async function cancelGeneration(): Promise<void> {
    cancelRequested = true;
    abortController?.abort();
    addNotification({
      type: 'info',
      message: $_('notifications.cancel'),
    });
  }
</script>

<div class="w-full md:w-2/3 xl:w-1/2">
  <img
    src={logoSvgUrl}
    alt="pdiiif logo"
    class="w-24 mx-auto mb-4 filter drop-shadow-lg"
  />
  <div>
    {#each notifications as notification}
      <Notification
        type={notification.type}
        choices={notification.choices}
        on:close={() => {
          notification.onClose?.();
          notifications = notifications.filter((n) => n !== notification);
        }}
      >
        {notification.message}
      </Notification>
    {/each}
  </div>
  <div class="flex flex-col bg-blue-400 m-auto p-4 rounded-md shadow-lg">
    {#if infoPromise}
      <Preview {infoPromise} {estimatePromise} {canvasIdentifiers} />
    {/if}
    <div class="relative flex text-gray-700 justify-end">
      <input
        bind:this={manifestInput}
        class={classNames(
          'w-full h-10 px-3 text-base placeholder-gray-600 rounded-l-lg',
          {
            'border-4 border-red-500':
              manifestUrl.length > 0 && !manifestUrlIsValid,
          }
        )}
        type="url"
        placeholder="Manifest URL"
        name="manifest-url"
        disabled={currentProgress !== undefined && !pdfFinished}
        bind:value={manifestUrl}
      />
      <button
        on:click={generatePdf}
        disabled={!manifestUrlIsValid || (currentProgress && !pdfFinished)}
        class="inset-y-0 right-0 flex items-center p-1 px-2 font-bold text-white disabled:opacity-25 bg-brand rounded-r whitespace-nowrap"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          class="w-7 h-7 fill-current mr-2"
        >
          <title>{$_('buttons.generate')}</title>
          <path
            d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z"
          />
        </svg>
        {$_('buttons.generate')}
      </button>
    </div>
    {#if manifestInfo}
      <Settings
        bind:scaleFactor
        bind:canvasIdentifiers
        bind:optimizationConfig
        {manifestInfo}
        {estimatePromise}
        disabled={currentProgress && !pdfFinished}
      />
    {/if}
    {#if (currentProgress || queueState) && !pdfFinished && !cancelled}
      <div>
        {#if window.Notification && window.Notification.permission !== 'denied'}
          <label
            ><input type="checkbox" bind:checked={notifyWhenDone} />
            {$_('buttons.notify')}</label
          >
        {/if}
        <ProgressBar
          currentProgress={{
            current: queueState
              ? queueState.initial - queueState.current
              : currentProgress?.bytesWritten ?? 0,
            total: queueState
              ? queueState.initial
              : currentProgress?.estimatedFileSize ?? Number.MAX_SAFE_INTEGER,
          }}
        >
          <span>
            {#if queueState}
              {$_('queue_position', {
                values: { pos: queueState.current },
              })}
            {:else if currentProgress?.estimatedFileSize}
              {(currentProgress.bytesWritten / (1024 * 1024)).toFixed(1)}MiB / ~{(
                currentProgress.estimatedFileSize /
                (1024 * 1024)
              ).toFixed(1)}MiB ({(
                currentProgress.writeSpeed /
                (1024 * 1024)
              ).toFixed(1)} MiB/s)
            {/if}
          </span>
        </ProgressBar>
      </div>
      {#if abortController && !cancelled}
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
  <div
    class="flex md:justify-start justify-center items-start mt-2 text-gray-500 text-xs"
  >
    <div class="mx-2">
      <a
        href="https://github.com/jbaiter/pdiiif"
        target="_blank"
        rel="noreferrer"
        class="hover:text-gray-800"
        ><GitHubIcon classes="text-gray-500 inline align-text-top w-4 h-4" />
        {$_('links.source')}</a
      >
    </div>
    <div class="mx-2">
      <a
        href="https://github.com/jbaiter/pdiiif/discussions"
        target="_blank"
        rel="noreferrer"
        class="hover:text-gray-800"
      >
        <QuestionIcon classes="text-gray-500 inline align-text-top w-4 h-4" />
        {$_('links.question')}</a
      >
    </div>
    <div class="mx-2">
      <a
        href="https://github.com/jbaiter/pdiiif/issues/new"
        target="_blank"
        rel="noreferrer"
        class="hover:text-gray-800"
        ><ErrorIcon classes="text-gray-500 inline align-text-top w-4 h-4" />
        {$_('links.problem')}</a
      >
    </div>
  </div>
</div>
