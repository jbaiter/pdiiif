/// <reference types="wicg-file-system-access"/>
import type { Writable } from 'stream';
import {
  Canvas,
  Manifest,
  PropertyValue,
  Range as IIIFRange,
  TreeNode,
} from 'manifesto.js';
import meanBy from 'lodash/meanBy';
import sampleSize from 'lodash/sampleSize';
import orderBy from 'lodash/orderBy';
import PQueue from 'p-queue';

import PDFGenerator from './pdf/generator';
import { CountingWriter, WebWriter, NodeWriter, Writer } from './io';
import { TocItem } from './pdf/util';
import { getLicenseInfo } from './res/licenses';
import { getTextSeeAlso } from './ocr';
import pdiiifVersion from './version';
import { fetchImage, fetchRespectfully, ImageData } from './download';
import metrics from './metrics';
import { CancelToken, now } from './util';

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
  languagePreference?: readonly string[] | string;
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
  /** Token that allows cancelling the PDF generation. All pending
      downloads will be terminated. The caller is responsible for
      removing underlying partial files and/or other user signaling. */
  cancelToken?: CancelToken;
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
}

/** Parameters for size estimation */
export interface EstimationParams {
  /** The manifest to determine the PDF size for */
  manifestJson: any;
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
  manifestJson,
  concurrency = 1,
  scaleFactor,
  filterCanvases = () => true,
  numSamples = 8,
}: EstimationParams): Promise<number> {
  const manifest = new Manifest(manifestJson);
  let canvasPredicate: (canvasId: string) => boolean;
  if (Array.isArray(filterCanvases)) {
    canvasPredicate = (canvasId) => filterCanvases.indexOf(canvasId) >= 0;
  } else {
    canvasPredicate = filterCanvases as (id: string) => boolean;
  }

  const canvases = manifest
    .getSequenceByIndex(0)
    .getCanvases()
    .filter((c) => canvasPredicate(c.id));

  // Select some representative canvases that are close to the mean in terms
  // of their pixel area to avoid small images distorting the estimate too much
  const meanPixels = meanBy(canvases, (c) => c.getWidth() * c.getHeight());
  const candidateCanvases = canvases.filter(
    (c) =>
      Math.abs(meanPixels - c.getWidth() * c.getHeight()) <= 0.25 * meanPixels
  );
  const sampleCanvases = sampleSize(candidateCanvases, numSamples);
  const totalCanvasPixels = canvases.reduce(
    (sum, canvas) => sum + canvas.getWidth() * canvas.getHeight(),
    0
  );
  const samplePixels = sampleCanvases.reduce(
    (sum, canvas) => sum + canvas.getWidth() * canvas.getHeight(),
    0
  );
  const queue = new PQueue({ concurrency });
  const sizePromises: Array<Promise<ImageData | undefined>> =
    sampleCanvases.map((c) =>
      queue.add(() =>
        fetchImage(c, { scaleFactor, sizeOnly: true })
      )
    );
  const imgData = await Promise.all(sizePromises);
  const sampleBytes = imgData
    .filter((i) => i !== undefined)
    .reduce((size: number, data) => size + (data?.numBytes ?? 0), 0);
  const bpp = sampleBytes / samplePixels;
  return bpp * totalCanvasPixels;
}

function buildOutlineFromRanges(
  manifest: Manifest,
  canvases: Canvas[],
  languagePreference: string[]
): Array<TocItem> {
  // ToC generation: IIIF's `Range` construct is so open, doing anything useful with it is a pain :-/
  // In our case, the pain comes from multiple directions:
  // - PDFs can only connect an outline node to a *single* page (IIIF connects ranges of pages)
  // - IIIF doesn't prescribe an order for the ranges or the canvases contained in them
  // Our approach is to pre-generate the range associated with each canvas and a hierarchy
  // of parent-child relationships for ranges.

  // All canvas identifiers in the order they appear as in the sequence
  const canvasIds = canvases.map((canvas) => canvas.id);

  let tocTree = manifest.getDefaultTree();
  if (!tocTree?.nodes?.length) {
    tocTree = manifest.getTopRanges()[0]?.getTree(new TreeNode('root'));
  }

  // We have to recurse, this small closure handles each node in the tree
  const handleTocNode = (node: TreeNode): TocItem | undefined => {
    if (!node.isRange()) {
      return;
    }
    const range = node.data as IIIFRange;
    // FIXME: When this code was written, Manifesto didn't yet support IIIFv3 ranges,
    //        check if this is still the case
    let firstCanvas;
    if (range.__jsonld.canvases) {
      firstCanvas = orderBy(range.__jsonld.canvases, (canvasId) =>
        canvasIds.indexOf(canvasId)
      )[0];
    } else if (range.__jsonld.members) {
      firstCanvas = orderBy(
        range.__jsonld.members.filter((m: any) => m['@type'] === 'sc:Canvas'),
        (canvas) => canvasIds.indexOf(canvas['@id'])
      )[0];
    } else if (range.__jsonld.items) {
      firstCanvas = orderBy(
        range.__jsonld.items.filter((m: any) => m.type === 'Canvas'),
        (canvas) => canvasIds.indexOf(canvas.id)
      )[0];
    }
    if (!firstCanvas) {
      return;
    }
    const rangeLabel = range
      .getLabel()
      .getValue(languagePreference as string[]);
    if (!rangeLabel) {
      return;
    }
    return {
      label: rangeLabel,
      startCanvasIdx: canvasIds.indexOf(firstCanvas),
      children: node.nodes.map(handleTocNode).filter((n): n is TocItem => !!n),
    };
  };

  if (tocTree) {
    // Descend into the tree
    if (tocTree.isRange()) {
      return handleTocNode(tocTree)?.children ?? [];
    } else {
      return tocTree.nodes.map(handleTocNode).filter((n): n is TocItem => !!n);
    }
  }
  return [];
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
    canvases: Canvas[],
    countingStream: CountingWriter,
    pdfGen: PDFGenerator,
    onProgress?: (status: ProgressStatus) => void
  ) {
    this.totalCanvasPixels = canvases.reduce(
      (sum, canvas) => sum + canvas.getWidth() * canvas.getHeight(),
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
  manifest: Manifest,
  languagePreference: Array<string>,
  endpoint?: string,
  callback?: (params: CoverPageParams) => Promise<Uint8Array>
): Promise<Uint8Array> {
  const params: CoverPageParams = {
    // NOTE: Manifest label is mandatory, i.e. safe to assert non-null
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    title: manifest.getLabel().getValue(languagePreference)!,
    manifestUrl: manifest.id,
    pdiiifVersion,
  };
  const thumb = manifest.getThumbnail();
  if (thumb != null) {
    params.thumbnail = {
      url: thumb.id,
      iiifImageService: thumb
        .getServices()
        .find((s) => s.getProfile().indexOf('/image/') > 0)?.id,
    };
  } else {
    const firstCanvas = manifest
      .getSequenceByIndex(0)
      .getCanvasByIndex(0) as Canvas;
    const canvasImg = firstCanvas.getImages()[0].getResource();
    params.thumbnail = {
      url: canvasImg.id,
      iiifImageService: canvasImg
        .getServices()
        .find((s) => s.getProfile().indexOf('/image/') > 0)?.id,
    };
  }
  const provider = manifest.getProperty('provider');
  const required = manifest.getRequiredStatement();
  const logo = manifest.getLogo();
  if (provider || (!required?.label && required?.value !== undefined)) {
    params.provider = {
      label: provider
        ? (PropertyValue.parse(provider.label).getValue(
            languagePreference
          ) as string)
        : required?.getValue(languagePreference) ?? '',
      homepage: provider?.homepage?.[0]?.id,
      logo: provider?.logo?.[0]?.id ?? logo,
    };
  }
  if (required != null && required.label) {
    params.requiredStatement = {
      label: required.getLabel(languagePreference) ?? '',
      value: required.getValues(languagePreference).join('\n'),
    };
  }
  const license = manifest.getLicense() ?? manifest.getProperty('rights');
  if (license != null) {
    const licenseDef = getLicenseInfo(license);
    params.rights = {
      text: licenseDef?.text ?? license,
      url: license,
      logo: licenseDef?.logo,
    };
  }
  params.metadata = manifest
    .getMetadata()
    .map((lvp) => {
      const label = lvp.getLabel(languagePreference);
      const values = lvp
        .getValues(languagePreference)
        .filter((v): v is string => v !== null);
      if (!label || values.length === 0) {
        return;
      }
      if (values.length === 1) {
        return [label, values[0]];
      } else {
        return [label, values];
      }
    })
    .filter((x): x is [string, string | string[]] => x !== undefined);
  if (callback) {
    return callback(params);
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

/** Convert a IIIF manifest to a PDF,  */
export async function convertManifest(
  /* eslint-disable  @typescript-eslint/explicit-module-boundary-types */
  manifestJson: any,
  outputStream: Writable | WritableStream,
  {
    filterCanvases = () => true,
    languagePreference = [Intl.DateTimeFormat().resolvedOptions().locale],
    scaleFactor,
    metadata = {},
    onProgress,
    ppi,
    concurrency = 1,
    cancelToken = new CancelToken(),
    coverPageCallback,
    coverPageEndpoint,
  }: ConvertOptions
): Promise<void> {
  let writer: Writer;
  // Can't use `instanceof` since we don't have the Node class in the
  // browser and vice versa, so examine the shape of the object
  if (typeof (outputStream as WritableStream).close === 'function') {
    writer = new WebWriter(outputStream as WritableStream);
  } else {
    writer = new NodeWriter(outputStream as Writable);
    // Cancel further processing once the underlying stream has been closed
    // This will only have an effect if the PDF has not finished generating
    // yet (i.e. when the client terminates the connection prematurely),
    // otherwise all processing will long have stopped
    (outputStream as Writable).on('close', () => cancelToken.requestCancel());
  }
  const countingWriter = new CountingWriter(writer);

  // Build a canvas predicate function from a list of identifiers, if needed
  let canvasPredicate: (canvasId: string) => boolean;
  if (Array.isArray(filterCanvases)) {
    canvasPredicate = (canvasId) => filterCanvases.indexOf(canvasId) >= 0;
  } else {
    canvasPredicate = filterCanvases as (id: string) => boolean;
  }

  const manifest = new Manifest(manifestJson);

  const pdfMetadata = { ...metadata };
  if (!pdfMetadata.Title) {
    pdfMetadata.Title =
      manifest.getLabel().getValue(languagePreference as string[]) ?? undefined;
  }

  const canvases = manifest
    .getSequenceByIndex(0)
    .getCanvases()
    .filter((c) => canvasPredicate(c.id));
  const hasText = !!canvases.find((c) => !!getTextSeeAlso(c));
  const labels = canvases.map(
    (canvas) => canvas.getLabel().getValue(languagePreference as string[]) ?? ''
  );

  // Fetch images concurrently, within limits specified by user
  const queue = new PQueue({ concurrency });
  cancelToken.addOnCancelled(() => queue.clear());
  const imgFuts = canvases.map((c) => {
    return queue.add(() =>
      fetchImage(c, { scaleFactor, ppiOverride: ppi, cancelToken })
    );
  });

  const outline = buildOutlineFromRanges(
    manifest,
    canvases,
    languagePreference as string[]
  );
  const pdfGen = new PDFGenerator(
    countingWriter,
    pdfMetadata,
    canvases.length,
    labels,
    outline,
    hasText
  );
  await pdfGen.setup();
  const progress = new ProgressTracker(
    canvases,
    countingWriter,
    pdfGen,
    onProgress
  );
  progress.emitProgress(0);

  if (coverPageCallback || coverPageEndpoint) {
    progress.emitProgress(0, 'Generating cover page');
    const coverPageData = await getCoverPagePdf(
      manifest,
      languagePreference as string[],
      coverPageEndpoint,
      coverPageCallback
    );
    await pdfGen.insertCoverPages(coverPageData);
  }

  progress.emitProgress(0, 'Downloading images and generating PDF pages');
  for (let canvasIdx = 0; canvasIdx < canvases.length; canvasIdx++) {
    if (cancelToken.isCancellationConfirmed) {
      break;
    }
    const canvas = canvases[canvasIdx];
    try {
      const imgData = await imgFuts[canvasIdx];
      // This means the task was aborted, do nothing
      if (imgData) {
        const { width, height, data, ppi, text } = imgData;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const stopMeasuring = metrics?.pageGenerationDuration.startTimer();
        await pdfGen.renderPage({ width, height }, data!, text, ppi);
        stopMeasuring?.();
        progress.updatePixels(
          width * height,
          canvas.getWidth() * canvas.getHeight()
        );
      }
    } catch (err) {
      // Clear queue, cancel all ongoing image fetching
      console.error(err);
      queue.clear();
      await cancelToken.requestCancel();
      throw err;
    } finally {
      delete imgFuts[canvasIdx];
    }
    progress.emitProgress(canvasIdx + 1);
  }

  // Finish writing PDF, resulting Promise is resolved once the writer is closed
  const endPromise = pdfGen.end();

  // At this point the PDF data might still be incomplete, so we wait for
  // drain events on the writer and continue updating our progress tracker
  // until the writer is actually closed
  if (!cancelToken.cancelled) {
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
  await endPromise;
}
