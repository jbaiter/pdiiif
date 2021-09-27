/* eslint-disable no-await-in-loop */
/// <reference types="wicg-file-system-access"/>
import type { Writable } from 'stream';
import { Canvas, Manifest, Range as IIIFRange, TreeNode } from 'manifesto.js';
import fetch from 'cross-fetch';
import minBy from 'lodash/minBy';
import meanBy from 'lodash/meanBy';
import sampleSize from 'lodash/sampleSize';
import orderBy from 'lodash/orderBy';
import PQueue from 'p-queue';

import PDFGenerator from './pdf/generator';
import { CountingWriter, WebWriter, NodeWriter, Writer } from './writers';
import { TocItem } from './pdf/util';

const FALLBACK_PPI = 300;

/** Progress information for rendering a progress bar or similar UI elements. */
export interface ProgressStatus {
  /// Expected total number of pages in the PDF
  totalPages: number;
  /// Number of pages that were submitted for writing
  pagesWritten: number;
  /// Number of bytes that were submitted for writing to the output stream
  bytesPushed: number;
  /// Number of bytes that were written to the output stream so far
  bytesWritten: number;
  /// Predicted size of the final file in bytes
  estimatedFileSize?: number;
  /// Write speed in bytes per second
  writeSpeed: number;
  /// Estimated time in seconds until PDF has finished generating
  remainingDuration: number;
}

type CancelCallback = () => void;
/** Token used for managing the cancellation of long processes. */
export class CancelToken {
  isCancellationRequested = false;
  isCancellationConfirmed = false;
  onCancelled: CancelCallback[] = [];

  requestCancel(): Promise<void> {
    const promise: Promise<void> = new Promise((resolve) =>
      this.addOnCancelled(resolve)
    );
    this.isCancellationRequested = true;
    return promise;
  }

  confirmCancelled(): void {
    if (this.isCancellationConfirmed) {
      return;
    }
    this.isCancellationConfirmed = true;
    this.onCancelled.forEach((cb) => cb());
  }

  addOnCancelled(cb: CancelCallback): void {
    this.onCancelled.push(cb);
  }

  get cancelled(): boolean {
    return this.isCancellationRequested || this.isCancellationConfirmed;
  }

  then(resolve: () => void): void {
    this.onCancelled.push(() => resolve());
  }
}

/** Options for converting a IIIF Manifest to a PDF. */
export interface ConvertOptions {
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
  /// Prefer lossless formats (PNG or TIF) over lossy (JPG, default)
  preferLossless?: boolean;
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
}

/** Container for image size along with its corresponding IIIF Image API string. */
interface SizeInfo {
  iiifSize: string;
  width: number;
  height: number;
}

/** Calculate the image size to fetch, based on user constraints and available sizes
 *  in the Image API info.json response.
 */
function getImageSize(infoJson: any, requestedWidth?: number): SizeInfo {
  let sizeStr: string;
  let maxWidth = requestedWidth;
  const aspectRatio = infoJson.width / infoJson.height;
  const supportsScaleByWh =
    (infoJson.profile instanceof String &&
      infoJson.profile.indexOf('level2') >= 0) ||
    infoJson.profile[0].indexOf('level2') >= 0 ||
    infoJson.profile[1]?.supports?.indexOf('sizeByWh') >= 0;
  if (maxWidth && !supportsScaleByWh) {
    // AR-compliant downscaling is not supported, find the closest available size
    maxWidth = minBy(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      infoJson.sizes.map((dims: any) => Math.abs(maxWidth! - dims.width))
    );
    sizeStr = `${maxWidth},`;
  } else if (!maxWidth) {
    if (infoJson.maxWidth) {
      maxWidth = infoJson.maxWidth;
      sizeStr = `${maxWidth},`;
    } else if (infoJson.maxHeight) {
      maxWidth = Math.round(aspectRatio * infoJson.maxHeight);
      sizeStr = `,${infoJson.maxHeight}`;
    } else if (infoJson.maxArea) {
      const fullArea = infoJson.width * infoJson.height;
      const scaleFactor = infoJson.maxArea / fullArea;
      maxWidth = Math.round(scaleFactor * infoJson.width);
      sizeStr = 'max';
    } else {
      sizeStr = 'full';
      maxWidth = infoJson.width;
    }
  } else {
    sizeStr = `${maxWidth},`;
  }
  return {
    iiifSize: sizeStr,
    width: maxWidth as number,
    height: (maxWidth as number) / aspectRatio,
  };
}

/** Use a IIIF Physical Dimensions service to obtain the PPI for a canvas. */
function getPointsPerInch(
  infoJson: any,
  canvas: Canvas,
  imgWidth: number,
  ppiOverride?: number
): number {
  if (ppiOverride) {
    return ppiOverride;
  }
  let physDimService: any = canvas
    .getServices()
    .find((service) => service.getProfile().indexOf('physdim') > 0);
  if (!physDimService && infoJson.service !== undefined) {
    const services = Array.isArray(infoJson?.service)
      ? infoJson.service
      : [infoJson.service];
    physDimService = services.find(
      (service: any) => service.profile.indexOf('physdim') > 0
    );
  }
  if (!physDimService) {
    // We assume the fallback PPI is in relation to the canvas size.
    return FALLBACK_PPI * (imgWidth / canvas.getWidth());
  }
  const { physicalScale, physicalUnits } = physDimService;
  let ppi;
  if (physicalUnits === 'in') {
    ppi = 1 / physicalScale;
  } else if (physicalUnits === 'mm') {
    ppi = 25.4 / physicalScale;
  } else if (physicalUnits === 'cm') {
    ppi = 2.54 / physicalScale;
  } else {
    ppi = FALLBACK_PPI;
  }
  return ppi * (imgWidth / infoJson.width);
}

/** Parameters for size estimation */
interface EstimationParams {
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
  /// Prefer lossless formats (PNG or TIF) over lossy (JPG, default)
  preferLossless?: boolean;
  /// Number of canvses to sample for estimation, defaults to 8
  numSamples?: number;
  /// Number of concurrent IIIF Image API requests to be performed, defaults to 1
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
  maxWidth,
  filterCanvases = () => true,
  preferLossless = false,
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
        fetchImage(c, { preferLossless, maxWidth, sizeOnly: true })
      )
    );
  const imgData = await Promise.all(sizePromises);
  const sampleBytes = imgData
    .filter((i) => i !== undefined)
    .reduce((size: number, data) => size + (data?.numBytes ?? 0), 0);
  const bpp = sampleBytes / samplePixels;
  return bpp * totalCanvasPixels;
}

/** Image data and associated information */
interface ImageData {
  data?: ArrayBuffer;
  width: number;
  height: number;
  ppi: number;
  numBytes: number;
}

/** Options for fetching image */
interface FetchImageOptions {
  preferLossless: boolean;
  maxWidth?: number;
  /// PPI override, will be fetched from physical dimensions serivce by default 
  ppiOverride?: number;
  cancelToken?: CancelToken;
  /// Only obtain the size of the image, don't fetch any data
  sizeOnly?: boolean;
}

async function fetchImage(
  canvas: Canvas,
  {
    preferLossless = false,
    maxWidth,
    ppiOverride,
    cancelToken,
    sizeOnly = false,
  }: FetchImageOptions
): Promise<ImageData | undefined> {
  if (cancelToken?.cancelled) {
    if (!cancelToken.isCancellationConfirmed) {
      cancelToken.confirmCancelled();
    }
    return undefined;
  }
  const img = canvas.getImages()[0].getResource();
  let imgUrl: string;
  let width: number;
  let height: number;
  let infoJson: any;
  if (img.getServices().length > 0) {
    const imgService = img.getServices()[0];
    infoJson = await (await fetch(`${imgService.id}/info.json`)).json();
    if (cancelToken?.isCancellationConfirmed) {
      return;
    } else if (cancelToken?.isCancellationRequested) {
      cancelToken.confirmCancelled();
      return;
    }
    let imgFormat = 'jpg';
    if (preferLossless) {
      // Check for PNG support
      const canPng =
        infoJson.profile[0].endsWith('level2.json') ||
        infoJson.profile[1].indexOf('png') >= 0;
      const canTif =
        infoJson.profile.length > 1 && infoJson.profile.indexOf('tif') >= 0;
      if (canPng) {
        imgFormat = 'png';
      } else if (canTif) {
        imgFormat = 'tif';
      }
    }
    const sizeInfo = getImageSize(infoJson, maxWidth);
    const { iiifSize } = sizeInfo;
    width = sizeInfo.width;
    height = sizeInfo.height;
    imgUrl = `${imgService.id}/full/${iiifSize}/0/default.${imgFormat}`;
  } else {
    imgUrl = img.id;
    width = img.getWidth();
    height = img.getHeight();
    infoJson = { width, height };
  }
  let imgResp = await fetch(imgUrl, { method: sizeOnly ? 'HEAD' : 'GET' });
  if (imgResp.status >= 400) {
    throw new Error(
      `Failed to fetch page image from ${imgUrl}, server returned status ${imgResp.status}`
    );
  }
  if (cancelToken?.isCancellationRequested) {
    cancelToken.confirmCancelled();
    return;
  }
  const imgData = sizeOnly ? undefined : await imgResp.arrayBuffer();
  let imgSize = Number.parseInt(imgResp.headers.get('Content-Length') ?? '-1');
  if (sizeOnly && imgSize < 0) {
    // Server did not send content length for HEAD request gotta fetch image wholly
    imgResp = await fetch(imgUrl);
    imgSize = (await imgResp.arrayBuffer()).byteLength;
  }
  return {
    data: imgData,
    width,
    height,
    ppi: getPointsPerInch(infoJson, canvas, width, ppiOverride),
    numBytes: imgSize,
  };
}

/** Get a timestamp in milliseconds, prefereably high-resolution */
function now(): number {
  if (typeof window !== 'undefined' && window.performance) {
    return window.performance.now();
  } else {
    return Date.now();
  }
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

  /// All canvas identifiers in the order they appear as in the sequence
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
    }
  };

  if (tocTree) {
    // Descend into the tree
    if (tocTree.isRange()) {
      return handleTocNode(tocTree)?.children ?? [];
    } else {
      return tocTree.nodes.map(handleTocNode).filter((n): n is TocItem => !!n)
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

  constructor(canvases: Canvas[], countingStream: CountingWriter, pdfGen: PDFGenerator, onProgress?: (status: ProgressStatus) => void) {
    this.totalCanvasPixels = canvases.reduce(
      (sum, canvas) => sum + canvas.getWidth() * canvas.getHeight(),
      0
    );
    this.totalPages = canvases.length;
    this.pdfGen = pdfGen;
    this.countingStream = countingStream;
    this.onProgress = onProgress;
  }

  get writeOutstanding(): boolean {
    return this.pdfGen.bytesWritten > this.countingStream.bytesWritten;
  }

  emitProgress(pagesWritten: number): void {
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
      pagesWritten,
      totalPages: this.totalPages,
      bytesWritten,
      bytesPushed,
      estimatedFileSize,
      writeSpeed,
      remainingDuration,
    });
  }

  updatePixels(pixelsWritten: number, canvasPixels: number) {
    this.pixelsWritten += pixelsWritten;
    this.canvasPixels += canvasPixels;
    this.pixelScaleFactor = this.pixelsWritten / this.canvasPixels;
    this.pixelBytesFactor = this.pdfGen.bytesWritten / this.pixelsWritten;
  }
}

export async function convertManifest(
  /* eslint-disable  @typescript-eslint/explicit-module-boundary-types */
  manifestJson: any,
  outputStream: Writable | WritableStream,
  {
    filterCanvases = () => true,
    languagePreference = [Intl.DateTimeFormat().resolvedOptions().locale],
    maxWidth,
    metadata = {},
    onProgress,
    ppi,
    preferLossless = false,
    concurrency = 1,
    cancelToken = new CancelToken(),
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
  const labels = canvases.map(
    (canvas) => canvas.getLabel().getValue(languagePreference as string[]) ?? ''
  );
  const outline = buildOutlineFromRanges(manifest, canvases, languagePreference as string[]);
  const pdfGen = new PDFGenerator(countingWriter, metadata, canvases.length, labels, outline);
  const progress = new ProgressTracker(canvases, countingWriter, pdfGen, onProgress);
  progress.emitProgress(0);

  // Fetch images concurrently, within limits specified by user
  const queue = new PQueue({ concurrency });
  cancelToken.addOnCancelled(() => queue.clear());
  const imgFuts = canvases.map((c) => {
    return queue.add(() =>
      fetchImage(c, { preferLossless, maxWidth, ppiOverride: ppi, cancelToken })
    );
  });

  for (let canvasIdx = 0; canvasIdx < canvases.length; canvasIdx++) {
    if (cancelToken.isCancellationConfirmed) {
      break;
    }
    const canvas = canvases[canvasIdx];
    try {
      const imgData = await imgFuts[canvasIdx];
      // This means the task was aborted, do nothing
      if (imgData) {
        const { width, height, data, ppi } = imgData;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        await pdfGen.renderPage({ width, height }, data!, ppi);
        progress.updatePixels(width * height, canvas.getWidth() * canvas.getHeight());
      }
    } catch (err) {
      // Clear queue, cancel all oingoing image fetching
      console.error(err);
      queue.clear();
      await cancelToken.requestCancel();
      throw err;
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
    endPromise.then(() => closed = true);
    const progressOnDrain = () => {
      if (closed) {
        return;
      }
      progress.emitProgress(canvases.length);
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
