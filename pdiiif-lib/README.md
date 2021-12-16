# pdiiif-lib

## Sample Usage

The example code below will generate a PDF in the browser, using the
public cover page API hosted at https://pdiiif.jbaiter.de and print
the progress to the console.

```javascript
import { convertManifest, estimatePdfSize } from 'pdiiif-lib';

// Fetch the manifest
const manifestUrl = 'https://iiif.wellcomecollection.org/presentation/v2/b18035723';
const manifestResp = await fetch(manifestUrl);
const manifest = await manifestResp.json();

// Estimate how large a PDF will probably be given the parameters
const estimatedSizeInBytes = await estimatePdfSize({
  manifestJson: manifest,
  maxWidth: 1500,
});

// Get a writable handle to a file on the user's machine
const handle = await showSaveFilePicker({
  suggestedName: 'manifest.pdf',
  types: [
  {
    description: 'PDF file',
    accept: { 'application/pdf': ['.pdf'] },
  }],
});
if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
  console.error(`no permission to write to '${handle.name}'`);
} else {
  pdfPath = (await handle.getFile()).name;
  const webWritable = await handle.createWritable();

  // Start the PDF generation
  const onProgress = status => {
    console.log(`Wrote ${status.pagesWritten} of ${totalPages}.`);
  }
  await convertManifest(
    manifest,
    webWritable,
    {
      maxWidth: 1500,
      onProgress,
      coverPageEndpoint: 'https://pdiiif.jbaiter.de/api/coverpage'
    }
  });
}
```

## API

**convertManifest**: The main function of the libary, convert a manifest to a PDF and write it to a writable stream.

```typescript
convertManifest(
  manifestJson: any,
  writable: Writable /* NodeJS */ | WritableStream /* Browsers */,
  {
    /// Pixels per inch to assume for the full resolution version of each canvas.
    /// If not set, the conversion will use an available IIIF Physical Dimensions
    /// service to calculate the page dimensions instead.
    ppi?: number;
    /// Set of canvas ids to include in PDF, or a predicate to filter canvas identifiers
    /// by. By default, all canvases are included in the PDF.
    filterCanvases?: readonly string[] | ((canvasId: string) => boolean);
    /// List of languages to use for metadata, page labels and table of contents, in
    /// descending order of preference. Will use the environment's locale settings by
    /// default.
    languagePreference?: readonly string[] | string;
    /// Restrict the image size to include in the PDF. Only works with Level 2 Image API
    /// services that allow arbitrary downscaling, the conversion will not perform
    /// downscaling itself. For Level 1 endpoints, the closest available lower width
    /// will be selected.
    maxWidth?: number;
    /// Number of concurrent IIIF Image API requests to be performed, defaults to 1
    concurrency?: number;
    /// Callback that gets called whenever a page has finished, useful to render a
    /// progress bar.
    onProgress?: (status: ProgressStatus) => void;
    /// Token that allows cancelling the PDF generation. All pending
    /// downloads will be terminated. The caller is responsible for
    /// removing underlying partial files and/or other user signaling.
    cancelToken?: CancelToken;
    /// Set PDF metadata, by default `Title` will be the manifest's label.
    metadata?: {
      CreationDate?: Date;
      Title?: string;
      Author?: string;
      Keywords?: string;
    };
    // Endpoint to contact for retrieving PDF data with one or more cover pages
    // to insert before the canvas pages
    coverPageEndpoint?: string;
    // Callback to call for retrieving PDF data with one or more cover pages
    // to insert before the canvas pages
    coverPageCallback?: (params: CoverPageParams) => Promise<Uint8Array>;
})
```

**estimatePdfSize**: Estimate how large the PDF will be based on the parameters
and sampling a few pages. Returns the estimated file size in bytes.

```typescript
estimatePdfSize({
  /// The manifest to determine the PDF size for
  manifestJson: any;
  /// Restrict the image size to include in the PDF. Only works with Level 2 Image API
  /// services that allow arbitrary downscaling, the conversion will not perform
  /// downscaling itself. For Level 1 endpoints, the closest available lower width
  /// will be selected.
  maxWidth?: number;
  /// Set of canvas ids to include in PDF, or a predicate to filter canvas identifiers
  /// by. By default, all canvases are included in the PDF.
  filterCanvases?: readonly string[] | ((canvasId: string) => boolean);
  /// Number of canvses to sample for estimation, defaults to 8
  numSamples?: number;
  /// Number of concurrent IIIF Image API requests to be performed, defaults to 1
  concurrency?: number;
}): number;
```