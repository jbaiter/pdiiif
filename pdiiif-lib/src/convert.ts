/// <reference types="wicg-file-system-access"/>
import type { Writable } from 'stream';
import {
  Manifest,
  RangeItems,
  ManifestNormalized,
  CanvasNormalized,
  RangeNormalized,
  Reference,
  IIIFExternalWebResource,
  ContentResource,
  Service,
  ImageService,
  AnnotationNormalized,
  ResourceProviderNormalized,
  Annotation as IIIF3Annotation,
} from '@iiif/presentation-3';
import Presentation2 from '@iiif/presentation-2';
import { convertPresentation2 } from '@iiif/parser/presentation-2';
import { meanBy, sampleSize, orderBy } from 'lodash-es';
import PQueue from 'p-queue';

import PDFGenerator from './pdf/generator.js';
import {
  CountingWriter,
  WebWriter,
  NodeWriter,
  Writer,
  BlobWriter,
} from './io.js';
import { TocItem } from './pdf/util.js';
import { getLicenseInfo } from './res/licenses.js';
import { getTextSeeAlso } from './ocr.js';
import pdiiifVersion from './version.js';
import {
  fetchCanvasData,
  fetchRespectfully,
  CanvasData,
  fetchStartCanvasInfo,
  StartCanvasInfo,
} from './download.js';
import metrics from './metrics.js';
import { isDefined, now } from './util.js';
import log from './log.js';
import {
  getI18nValue,
  getThumbnail,
  getCanvasInfo,
  vault,
  parseAnnotation,
  Annotation,
} from './iiif.js';

/** Progress information for rendering a progress bar or similar UI elements. */
export interface ProgressStatus {
  /** Human-readable message about what is currently going on */
  message?: string;
  /** Expected total number of pages in the PDF */
  totalPages: number;
  /** Number of pages that were submitted for writing */
  pagesWritten: number;
  /** Number of bytes that were submitted for writing to the output stream */
  bytesPushed: number;
  /** Number of bytes that were written to the output stream so far */
  bytesWritten: number;
  /** Predicted size of the final file in bytes */
  estimatedFileSize?: number;
  /** Write speed in bytes per second */
  writeSpeed: number;
  /** Estimated time in seconds until PDF has finished generating */
  remainingDuration: number;
}

/** Parameters for rendering a cover page, parsed from IIIF manifest. */
export interface CoverPageParams {
  title: string;
  manifestUrl: string;
  thumbnail?: {
    url: string;
    iiifImageService?: string;
  };
  provider?: {
    label: string;
    homepage?: string;
    logo?: string;
  };
  requiredStatement?: {
    label: string;
    value: string;
  };
  rights?: {
    text: string;
    url?: string;
    logo?: string;
  };
  metadata?: Array<[string, string | Array<string>]>;
  pdiiifVersion: string;
}

/** Options for converting a IIIF Manifest to a PDF. */
export interface ConvertOptions {
  /** Callback to provide annotations for a given canvas identifier.
   * Should return either a `sc:AnnotationList` (IIIF2) or an `AnnotationPage` (IIIF3).
   */
  fetchCanvasAnnotations?: (
    canvasId: string
  ) => Promise<Array<IIIF3Annotation> | Array<Presentation2.Annotation>>;
  /** Pixels per inch to assume for the full resolution version of each canvas.
      If not set, the conversion will use an available IIIF Physical Dimensions
      service to calculate the page dimensions instead. */
  ppi?: number;
  /** Set of canvas ids to include in PDF, or a predicate to filter canvas identifiers
      by. By default, all canvases are included in the PDF. */
  filterCanvases?: readonly string[] | ((canvasId: string) => boolean);
  /** List of languages to use for metadata, page labels and table of contents, in
      descending order of preference. Will use the environment's locale settings by
      default. */
  languagePreference?: readonly string[];
  /** Restrict the image size to include in the PDF by downscaling by a fixed factor.
   * The value must be a number between 0.1 and 1.
   * Only works with Level 2 Image API services that allow arbitrary downscaling, the
   * conversion will not perform downscaling itself.
   * For Level 1 endpoints, the closest available lower width will be selected. */
  scaleFactor?: number;
  /** Number of maximum concurrent IIIF Image API requests to be performed, defaults to 1 */
  concurrency?: number;
  /** Callback that gets called whenever a page has finished, useful to render a
      progress bar. */
  onProgress?: (status: ProgressStatus) => void;
  /** Controller that allows aborting the PDF generation. All pending
      downloads will be terminated. The caller is responsible for
      removing underlying partial files and/or other user signaling. */
  abortController?: AbortController;
  /** Set PDF metadata, by default `Title` will be the manifest's label. */
  metadata?: {
    CreationDate?: Date;
    Title?: string;
    Author?: string;
    Keywords?: string;
  };
  /** Endpoint to contact for retrieving PDF data with one or more cover pages
      to insert before the canvas pages */
  coverPageEndpoint?: string;
  /** Callback to call for retrieving PDF data with one or more cover pages
      to insert before the canvas pages */
  coverPageCallback?: (params: CoverPageParams) => Promise<Uint8Array>;
  /** Generate the PDF in a way that the resulting file is also a valid
   *  ZIP file that contains the manifest, all of the images and, if present,
   *  the OCR files referenced in the manifest. */
  polyglotZipPdf?: boolean;
  /** Base directory in the polyglot ZIP archive. If not set, all resource
   * directories will be to-level in the archive. */
  polyglotZipBaseDir?: string;
}

/** Parameters for size estimation */
export interface EstimationParams {
  /** The manifest to determine the PDF size for */
  manifest: string | Manifest | Presentation2.Manifest;
  /** Restrict the image size to include in the PDF by downscaling by a fixed factor.
   * The value must be a number between 0.1 and 1.
   * Only works with Level 2 Image API services that allow arbitrary downscaling, the
   * conversion will not perform downscaling itself.
   * For Level 1 endpoints, the closest available lower width will be selected. */
  scaleFactor?: number;
  /** Set of canvas ids to include in PDF, or a predicate to filter canvas identifiers
      by. By default, all canvases are included in the PDF. */
  filterCanvases?: readonly string[] | ((canvasId: string) => boolean);
  /** Number of canvses to sample for estimation, defaults to 8 */
  numSamples?: number;
  /** Number of maximum concurrent IIIF Image API requests to be performed, defaults to 1 */
  concurrency?: number;
}

/** Estimate the final size of the PDF for a given manifest.
 *
 * This will randomly sample a few representative canvases from the manifest,
 * check their size in bytes and extrapolate from that to all canvases.
 */
export async function estimatePdfSize({
  manifest: inputManifest,
  concurrency = 1,
  scaleFactor,
  filterCanvases = () => true,
  numSamples = 8,
}: EstimationParams): Promise<number> {
  let manifestId;
  if (typeof inputManifest === 'string') {
    manifestId = inputManifest;
  } else {
    manifestId =
      (inputManifest as Manifest).id ??
      (inputManifest as Presentation2.Manifest)['@id'];
  }
  const manifest = await vault.loadManifest(manifestId);
  if (!manifest) {
    throw new Error(`Failed to load manifest from ${manifestId}`);
  }
  let canvasPredicate: (canvasId: string) => boolean;
  if (Array.isArray(filterCanvases)) {
    canvasPredicate = (canvasId) => filterCanvases.indexOf(canvasId) >= 0;
  } else {
    canvasPredicate = filterCanvases as (id: string) => boolean;
  }

  const canvases = vault.get<CanvasNormalized>(
    manifest.items.filter((c) => canvasPredicate(c.id))
  );

  // Select some representative canvases that are close to the mean in terms
  // of their pixel area to avoid small images distorting the estimate too much
  const totalCanvasPixels = canvases.reduce(
    (sum, canvas) => sum + canvas.width * canvas.height,
    0
  );
  let samplePixels = totalCanvasPixels;
  let sampleCanvases = canvases;
  if (canvases.length > numSamples) {
    const meanPixels = meanBy(canvases, (c) => c.width * c.height);
    const candidateCanvases = canvases.filter(
      (c) => Math.abs(meanPixels - c.width * c.height) <= 0.25 * meanPixels
    );
    sampleCanvases = sampleSize(candidateCanvases, numSamples);
    samplePixels = sampleCanvases.reduce(
      (sum, canvas) => sum + canvas.width * canvas.height,
      0
    );
  }
  const queue = new PQueue({ concurrency });
  const canvasData = await Promise.all(
    sampleCanvases.map((c) =>
      queue.add(() => fetchCanvasData(c, { scaleFactor, sizeOnly: true }))
    )
  );
  const sampleBytes = canvasData
    .filter(isDefined<CanvasData>)
    .flatMap((c) => c.images)
    .reduce((size: number, data) => size + (data?.numBytes ?? 0), 0);
  const bpp = sampleBytes / samplePixels;
  return bpp * totalCanvasPixels;
}

async function buildOutlineFromRanges(
  manifest: ManifestNormalized,
  canvases: CanvasNormalized[],
  languagePreference: string[]
): Promise<Array<TocItem>> {
  // ToC generation: IIIF's `Range` construct is so open, doing anything useful with it is a pain :-/
  // In our case, the pain comes from multiple directions:
  // - PDFs can only connect an outline node to a *single* page (IIIF connects ranges of pages)
  // - IIIF doesn't prescribe an order for the ranges or the canvases contained in them
  // Our approach is to pre-generate the range associated with each canvas and a hierarchy
  // of parent-child relationships for ranges.

  // All canvas identifiers in the order they appear as in the sequence
  const canvasIds = canvases.map((canvas) => canvas.id);

  // We have to recurse, this small closure handles each node in the tree
  const isCanvas = (ri: RangeItems): ri is Reference<'Canvas'> =>
    typeof ri !== 'string' && ri.type === 'Canvas';
  const isRange = (ri: RangeItems): ri is Reference<'Range'> =>
    typeof ri !== 'string' && ri.type == 'Range';

  const seenRanges: Set<string> = new Set();
  const handleTocRange = async (
    range: RangeNormalized
  ): Promise<TocItem | undefined> => {
    if (seenRanges.has(range.id)) {
      return;
    }
    const firstCanvas = orderBy(range.items.filter(isCanvas), (c) =>
      canvasIds.indexOf(c.id)
    )[0];
    const rangeLabel = getI18nValue(
      range.label ?? '<untitled>',
      languagePreference,
      '; '
    );
    const childRanges = vault.get<RangeNormalized>(range.items.filter(isRange));
    const children = (
      await Promise.all(childRanges.map(handleTocRange))
    ).filter(isDefined<TocItem>);

    let startCanvas: StartCanvasInfo | undefined;
    if (range.start) {
      startCanvas = await fetchStartCanvasInfo(range);
    }
    if (!startCanvas && firstCanvas) {
      startCanvas = firstCanvas.id;
    } else {
      startCanvas = children[0].startCanvas;
    }
    seenRanges.add(range.id);
    return {
      label: rangeLabel,
      startCanvas,
      children,
    };
  };

  return (
    (
      await Promise.all(
        vault.get<RangeNormalized>(manifest.structures).map(handleTocRange)
      )
    ).filter(isDefined<TocItem>) ?? []
  );
}

/** Tracks PDF generation progress and various statistics related to that. */
class ProgressTracker {
  canvasPixels = 0;
  pixelsWritten = 0;
  pixelBytesFactor = 0;
  pixelScaleFactor = 0;
  timeStart: number | undefined;

  pdfGen: PDFGenerator;
  totalPages: number;
  totalCanvasPixels = 0;
  countingStream: CountingWriter;
  onProgress?: (status: ProgressStatus) => void;

  constructor(
    canvases: CanvasNormalized[],
    countingStream: CountingWriter,
    pdfGen: PDFGenerator,
    onProgress?: (status: ProgressStatus) => void
  ) {
    this.totalCanvasPixels = canvases.reduce(
      (sum, canvas) => sum + canvas.width * canvas.height,
      0
    );
    this.totalPages = canvases.length;
    this.pdfGen = pdfGen;
    this.countingStream = countingStream;
    this.onProgress = onProgress;
  }

  /** Check if there is still data that needs to be written out. */
  get writeOutstanding(): boolean {
    return this.pdfGen.bytesWritten > this.countingStream.bytesWritten;
  }

  /** Emit a progress update, with an optional message. */
  emitProgress(pagesWritten: number, message?: string): void {
    if (!this.timeStart) {
      this.timeStart = now();
    }
    const bytesPushed = this.pdfGen.bytesWritten;
    let estimatedFileSize;
    if (pagesWritten === this.totalPages) {
      estimatedFileSize = bytesPushed;
    } else if (pagesWritten > 0) {
      estimatedFileSize = Math.floor(
        this.pixelBytesFactor * this.pixelScaleFactor * this.totalCanvasPixels
      );
    }
    const bytesWritten = this.countingStream.bytesWritten;
    const writeSpeed = bytesPushed / ((now() - this.timeStart) / 1000);
    let remainingDuration = Number.POSITIVE_INFINITY;
    if (estimatedFileSize) {
      remainingDuration = (estimatedFileSize - bytesWritten) / writeSpeed;
    }
    this.onProgress?.({
      message,
      pagesWritten,
      totalPages: this.totalPages,
      bytesWritten,
      bytesPushed,
      estimatedFileSize,
      writeSpeed,
      remainingDuration,
    });
  }

  /** Update how many actual pixels and 'canvas pixels' have been written. */
  updatePixels(pixelsWritten: number, canvasPixels: number) {
    this.pixelsWritten += pixelsWritten;
    this.canvasPixels += canvasPixels;
    this.pixelScaleFactor = this.pixelsWritten / this.canvasPixels;
    this.pixelBytesFactor = this.pdfGen.bytesWritten / this.pixelsWritten;
  }
}

/** Generate a cover page PDF, either via user-provided callback, or by fetching
 * it from a remote endpoint. */
async function getCoverPagePdf(
  manifest: ManifestNormalized,
  languagePreference: Array<string>,
  endpoint?: string,
  callback?: (params: CoverPageParams) => Promise<Uint8Array>
): Promise<Uint8Array> {
  const params: CoverPageParams = {
    // NOTE: Manifest label is mandatory, i.e. safe to assert non-null
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    title: getI18nValue(
      manifest.label ?? '<untitled>',
      languagePreference,
      '; '
    ),
    manifestUrl: manifest.id,
    pdiiifVersion,
  };
  const thumbUrl = await getThumbnail(manifest, 512);
  if (thumbUrl) {
    params.thumbnail = { url: thumbUrl };
    const manifestThumb = vault.get<ContentResource>(manifest.thumbnail)[0];
    if (manifestThumb && 'type' in manifestThumb) {
      params.thumbnail.iiifImageService = (
        manifestThumb as IIIFExternalWebResource
      ).service?.find(
        (s: Service): s is ImageService =>
          (s as ImageService | undefined)?.type?.startsWith('ImageService') ??
          false
      )?.id;
    }
  }

  const provider = vault.get<ResourceProviderNormalized>(manifest.provider)[0];
  const required = manifest.requiredStatement;
  if (provider) {
    params.provider = {
      label: getI18nValue(provider.label, languagePreference, '; '),
      homepage: provider.homepage?.[0].id,
      logo: provider.logo?.[0]?.id,
    };
    // FIXME: Currently this is assigned by @iiif/parser when converting from v2 to v3
    if (params.provider.label === 'Unknown') {
      params.provider.label = '';
    }
  }
  if (required != null && required.label) {
    params.requiredStatement = {
      label: getI18nValue(required.label, languagePreference, '; '),
      value: getI18nValue(required.value, languagePreference, '; '),
    };
  }
  const license = manifest.rights;
  if (license) {
    const licenseDef = getLicenseInfo(license);
    params.rights = {
      text: licenseDef?.text ?? license,
      url: license,
      logo: licenseDef?.logo,
    };
  }
  params.metadata =
    manifest.metadata
      ?.map((itm) => {
        const label = getI18nValue(itm.label, languagePreference, '; ');
        const values = getI18nValue(itm.value, languagePreference, '|||').split(
          '|||'
        );
        if (!label || values.length === 0) {
          return;
        }
        if (values.length === 1) {
          return [label, values[0]];
        } else {
          return [label, values];
        }
      })
      .filter((x): x is [string, string | string[]] => x !== undefined) ?? [];
  if (callback) {
    return await callback(params);
  } else if (endpoint) {
    const resp = await fetchRespectfully(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  } else {
    throw 'Either `endpoint` or `callback` must be specified!';
  }
}

export async function convertManifest(
  inputManifest: string | Manifest | Presentation2.Manifest,
  outputStream: Writable | WritableStream,
  options: ConvertOptions
): Promise<void>;
export async function convertManifest(
  inputManifest: string | Manifest | Presentation2.Manifest,
  outputStream: undefined,
  options: ConvertOptions
): Promise<Blob>;
/** Convert a IIIF manifest to a PDF,  */
export async function convertManifest(
  /* eslint-disable  @typescript-eslint/explicit-module-boundary-types */
  inputManifest: string | Manifest | Presentation2.Manifest,
  outputStream: Writable | WritableStream | undefined,
  {
    fetchCanvasAnnotations = () => Promise.resolve([]),
    filterCanvases = () => true,
    languagePreference = [Intl.DateTimeFormat().resolvedOptions().locale],
    scaleFactor,
    metadata = {},
    onProgress,
    ppi,
    concurrency = 1,
    abortController = new AbortController(),
    coverPageCallback,
    coverPageEndpoint,
    polyglotZipPdf,
    polyglotZipBaseDir,
  }: ConvertOptions
): Promise<void | Blob> {
  let writer: Writer;
  if (!outputStream) {
    log.debug('Writing to Blob');
    writer = new BlobWriter();
    // Can't use `instanceof` since we don't have the Node class in the
    // browser and vice versa, so examine the shape of the object
  } else if (typeof (outputStream as Writable).destroy === 'function') {
    log.debug('Writing to Node writable stream');
    writer = new NodeWriter(outputStream as Writable);
    // Cancel further processing once the underlying stream has been closed
    // This will only have an effect if the PDF has not finished generating
    // yet (i.e. when the client terminates the connection prematurely),
    // otherwise all processing will long have stopped
    (outputStream as Writable).on('close', () => abortController.abort());
  } else {
    log.debug('Writing to file system');
    writer = new WebWriter(outputStream as WritableStream);
  }
  const countingWriter = new CountingWriter(writer);

  // Build a canvas predicate function from a list of identifiers, if needed
  let canvasPredicate: (canvasId: string) => boolean;
  if (Array.isArray(filterCanvases)) {
    canvasPredicate = (canvasId) => filterCanvases.indexOf(canvasId) >= 0;
  } else {
    canvasPredicate = filterCanvases as (id: string) => boolean;
  }

  let manifestId: string;
  let manifestJson: Manifest | Presentation2.Manifest;
  if (typeof inputManifest === 'string') {
    manifestId = inputManifest;
    manifestJson = (await (await fetchRespectfully(manifestId)).json()) as
      | Manifest
      | Presentation2.Manifest;
  } else {
    manifestId =
      (inputManifest as Presentation2.Manifest)['@id'] ??
      (inputManifest as Manifest).id;
    manifestJson = inputManifest;
  }
  const manifest = await vault.loadManifest(manifestId, manifestJson);
  if (!manifest) {
    throw new Error(`Failed to load manifest from ${manifestId}`);
  }

  const pdfMetadata = { ...metadata };
  if (!pdfMetadata.Title && manifest.label) {
    pdfMetadata.Title = getI18nValue(
      manifest.label,
      languagePreference as string[],
      '; '
    );
  }

  const canvases = vault.get<CanvasNormalized>(
    manifest.items.filter((c) => canvasPredicate(c.id))
  );
  const hasText = !!canvases.find((c) => !!getTextSeeAlso(c));
  const labels = canvases.map((canvas) =>
    canvas.label ? getI18nValue(canvas.label, languagePreference, '; ') : ''
  );

  // Fetch images concurrently, within limits specified by user
  log.debug(`Setting up queue with ${concurrency} concurrent canvas fetches.`);
  const queue = new PQueue({ concurrency });
  abortController.signal.addEventListener('abort', () => queue.clear(), {
    once: true,
  });
  const canvasFuts = canvases.map((c) => {
    return queue.add(() =>
      fetchCanvasData(c, {
        scaleFactor,
        ppiOverride: ppi,
        abortSignal: abortController.signal,
      })
    );
  });

  const outline = await buildOutlineFromRanges(
    manifest,
    canvases,
    languagePreference as string[]
  );
  const pdfGen = new PDFGenerator({
    writer: countingWriter,
    metadata: pdfMetadata,
    canvasInfos: canvases.map((c, idx) => ({
      canvasIdx: idx,
      ...getCanvasInfo(c),
    })),
    langPref: languagePreference,
    pageLabels: labels,
    outline,
    hasText,
    initialCanvas: await fetchStartCanvasInfo(manifest),
    readingDirection:
      manifest.viewingDirection === 'right-to-left'
        ? 'right-to-left'
        : 'left-to-right',
    manifestJson,
    zipPolyglot: polyglotZipPdf,
    zipBaseDir: polyglotZipBaseDir,
  });
  log.debug(`Initialising PDF generator.`);
  await pdfGen.setup();
  const progress = new ProgressTracker(
    canvases,
    countingWriter,
    pdfGen,
    onProgress
  );
  progress.emitProgress(0);

  if (coverPageCallback || coverPageEndpoint) {
    log.debug(`Generating cover page`);
    progress.emitProgress(0, 'Generating cover page');
    try {
      const coverPageData = await getCoverPagePdf(
        manifest,
        languagePreference as string[],
        coverPageEndpoint,
        coverPageCallback
      );
      log.debug('Inserting cover page into PDF');
      await pdfGen.insertCoverPages(coverPageData);
    } catch (err) {
      log.error('Error while generating cover page', err);
      abortController.abort();
      throw err;
    }
  }

  progress.emitProgress(0, 'Downloading images and generating PDF pages');
  for (let canvasIdx = 0; canvasIdx < canvases.length; canvasIdx++) {
    if (abortController.signal.aborted) {
      log.debug('Abort signalled, aborting while waiting for image data.');
      break;
    }
    try {
      log.debug(`Waiting for data for canvas #${canvasIdx}`);
      const canvasData = await canvasFuts[canvasIdx];
      // This means the task was aborted, do nothing
      // FIXME: Doesn't this also happen in case of an error?
      if (!canvasData) {
        throw 'Aborted';
      }
      const canvas = vault.get<CanvasNormalized>(canvasData.canvas);
      const { images, ppi, text, annotations } = canvasData;
      const externalAnnotations = await fetchCanvasAnnotations(canvas.id);
      if (externalAnnotations != null) {
        const normalized = await Promise.all(
          externalAnnotations.map((a) => {
            if (!('id' in a)) {
              a = convertPresentation2(a) as IIIF3Annotation;
            }
            return vault.load<AnnotationNormalized>(a.id, a);
          })
        );
        if (normalized) {
          normalized
            .filter((a): a is AnnotationNormalized => a !== undefined)
            .map((a) => parseAnnotation(a, languagePreference))
            .filter((a): a is Annotation => a !== undefined)
            .forEach((a) => annotations.push(a));
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const stopMeasuring = metrics?.pageGenerationDuration.startTimer();
      log.debug(`Rendering canvas #${canvasIdx} into PDF`);
      await pdfGen.renderPage(
        canvasData.canvas.id,
        { width: canvas.width, height: canvas.height },
        images,
        annotations,
        text,
        ppi
      );
      stopMeasuring?.();
      progress.updatePixels(
        images.reduce(
          (acc, img) => acc + img.dimensions.width * img.dimensions.height,
          0
        ),
        canvas.width * canvas.height
      );
    } catch (err) {
      // Clear queue, cancel all ongoing image fetching
      if (err !== 'Aborted') {
        log.error('Failed to render page', err);
      }
      queue.clear();
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
      throw err;
    } finally {
      delete canvasFuts[canvasIdx];
    }
    progress.emitProgress(canvasIdx + 1);
  }

  // Finish writing PDF, resulting Promise is resolved once the writer is closed
  log.debug('Finalizing PDF');
  const endPromise = pdfGen.end();

  // At this point the PDF data might still be incomplete, so we wait for
  // drain events on the writer and continue updating our progress tracker
  // until the writer is actually closed
  if (!abortController.signal.aborted) {
    let closed = false;
    endPromise.then(() => (closed = true));
    const progressOnDrain = () => {
      if (closed) {
        return;
      }
      progress.emitProgress(canvases.length, 'Finishing PDF generation');
      if (!closed && progress.writeOutstanding) {
        writer.waitForDrain().then(progressOnDrain);
      }
    };

    // Wait for initial drainage event in case the writer isn't already closed
    if (!closed) {
      writer.waitForDrain().then(progressOnDrain);
    }
  }

  // Wait for the writer to be closed
  log.debug('Waiting for writer to close.');
  await endPromise;

  if (writer instanceof BlobWriter) {
    return writer.blob;
  }
}
