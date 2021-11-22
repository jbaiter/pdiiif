<script lang="ts">
  /// <reference types="wicg-file-system-access"/>
  import { convertManifest, ProgressStatus } from 'pdiiif';
  import { WritableAdapter } from './stream-adapters';

  export let apiEndpoint: string = 'http://localhost:31337/api';
  let manifestUrl: string;
  let error: string | undefined = undefined;
  let currentProgress: any; //ProgressStatus | undefined;

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

  async function generatePdfClientSide(): Promise<void> {
    // File System Access API is available
    const handle = await showSaveFilePicker({
      types: [{
        description: 'PDF file',
        accept: {'application/pdf': ['.pdf']},
      }],
    });
    if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      error = `no permission to write to '${handle.name}'`;
      return;
    }
    const webWritable = await handle.createWritable();
    const writable = new WritableAdapter(webWritable);
    let manifestResp: Response;
    try {
      manifestResp = await fetch(manifestUrl);
    } catch (err)  {
      error = `Failed to fetch manifest from ${manifestUrl}: ${err}`;
      return;
    }
    const manifestJson = await manifestResp.json();
    console.log(manifestJson);
    await convertManifest(manifestJson, writable, {
      languagePreference: window.navigator.languages,
      onProgress: (status) => {
        currentProgress = status;
      }
    });
  }

  async function generatePdfServerSide(): Promise<void> {
    const pdfEndpoint = `${apiEndpoint}/generate-pdf`;
    const progressToken = generateProgressToken();
    const progressEndpoint = `${apiEndpoint}/progress/${progressToken}`;
    const progressSource = new EventSource(progressEndpoint, { withCredentials: true });
    const promise: Promise<void> = new Promise(
      resolve => progressSource.addEventListener('progress', (evt) => {
        currentProgress = JSON.parse((evt as any).data);
        if (currentProgress.pagesWritten === currentProgress.totalPages) {
          resolve();
        }
      }));
    window.open(
      `${pdfEndpoint}?${new URLSearchParams({ manifestUrl, progressToken })}`
    );
    return promise;
  }

  async function generatePdf(): Promise<void> {
    if (typeof window.showSaveFilePicker === 'function') {
      return generatePdfClientSide();
    } else {
      return generatePdfServerSide();
    }
  }

</script>

<form on:submit={generatePdf}>
  <h1>Convert a IIIF Manifest to PDF</h1>
  <input value={manifestUrl}>
  <button type="submit">Generate PDF</button>
  <pre>
    {currentProgress}
  </pre>
</form>