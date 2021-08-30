/* eslint-disable no-await-in-loop */
/// <reference types="wicg-file-system-access"/>
import { Canvas, Manifest, Range as IIIFRange, TreeNode } from 'manifesto.js';
import fetch from 'cross-fetch';
import minBy from 'lodash/minBy';
import meanBy from 'lodash/meanBy';
import sampleSize from 'lodash/sampleSize';
import orderBy from 'lodash/orderBy';
import { Writable, WritableOptions } from 'stream';
import PQueue from 'p-queue';

import PDFGenerator from './pdf';
import { WritableAdapter } from './webstream-adapter';

const FALLBACK_PPI = 300;

/** Wraps a writable and counts the bytes written to it. */
class CountingWritable extends Writable {
  _stream: Writable;
  bytesWritten = 0;

  constructor(stream: Writable, options?: WritableOptions) {
    super(options);
    this._stream = stream;
  }

  _write(chunk: any, enc: string, cb: (error?: Error | null) => void) {
    this._stream.write(chunk, enc, cb);
    if (chunk instanceof Buffer) {
      this.bytesWritten += chunk.length;
    } else if (
      chunk instanceof Uint8Array ||
      chunk instanceof Uint16Array ||
      chunk instanceof Uint32Array
    ) {
      this.bytesWritten += chunk.byteLength;
    } else {
      console.warn(
        `Unknown chunk type, can't track progress:: ${typeof chunk}`
      );
    }
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this._stream.destroy(error ?? undefined);
    callback?.(error);
  }

  _final(cb: (error?: Error | null) => void): void {
    this._stream.end(cb);
  }
}

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
  const imgResp = await fetch(imgUrl, { method: sizeOnly ? 'HEAD' : 'GET' });
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
  return {
    data: imgData,
    width,
    height,
    ppi: getPointsPerInch(infoJson, canvas, width, ppiOverride),
    numBytes: Number.parseInt(imgResp.headers.get('Content-Length') ?? '-1'),
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

interface TocInfo {
  rangeParents: { [rangeId: string]: string[] };
  canvasRanges: { [canvasId: string]: { id: string; label: string } };
}

function buildPdfTocFromRanges(
  manifest: Manifest,
  canvases: Canvas[],
  languagePreference: string[]
): TocInfo {
  // ToC generation: IIIF's `Range` construct is so open, doing anything useful with it is a pain :-/
  // In our case, the pain comes from multiple directions:
  // - PDFs can only connect an outline node to a *single* page (IIIF connects ranges of pages)
  // - PDFKit can only add an outline item for the *current* page
  // - IIIF doesn't prescribe an order for the ranges or the canvases contained in them
  // Our approach is to pre-generate the range associated with each canvas and a hierarchy
  // of parent-child relationships for ranges.

  /// Parents for each IIIF Range
  const rangeParents: { [rangeId: string]: string[] } = {};
  /// All canvas identifiers in the order they appear as in the sequence
  const canvasIds = canvases.map((canvas) => canvas.id);
  /// Keep track of all ranges belonging to a canvas (i.e. ranges it's the "first" canvas of) and their outline parent, if present
  const canvasRanges: { [canvasId: string]: { id: string; label: string } } =
    {};
  let tocTree = manifest.getDefaultTree();
  if (!tocTree?.nodes?.length) {
    tocTree = manifest.getTopRanges()[0]?.getTree(new TreeNode('root'));
  }

  // We have to recurse, this small closure handles each node in the tree
  const handleTocNode = (node: TreeNode, parentId?: string): void => {
    let rangeId: string | undefined;
    if (node.isRange()) {
      const range = node.data as IIIFRange;
      if (parentId) {
        rangeParents[range.id] = [parentId, ...(rangeParents[parentId] ?? [])];
      }
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
      if (firstCanvas) {
        const rangeLabel = range
          .getLabel()
          .getValue(languagePreference as string[]);
        if (rangeLabel) {
          canvasRanges[firstCanvas] = { id: range.id, label: rangeLabel };
        }
        rangeId = range.id;
      }
    }

    for (const childNode of node.nodes) {
      handleTocNode(childNode, rangeId);
    }
  };

  if (tocTree) {
    // Descend into the tree
    handleTocNode(tocTree);
  }
  return {
    rangeParents,
    canvasRanges,
  };
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
  countingStream: CountingWritable;
  onProgress?: (status: ProgressStatus) => void;

  constructor(canvases: Canvas[], countingStream: CountingWritable, pdfGen: PDFGenerator, onProgress?: (status: ProgressStatus) => void) {
    this.totalCanvasPixels = canvases.reduce(
      (sum, canvas) => sum + canvas.getWidth() * canvas.getHeight(),
      0
    );
    this.totalPages = canvases.length;
    this.pdfGen = pdfGen;
    this.countingStream = countingStream;
    this.onProgress = onProgress;
  }

  emitProgress(pagesWritten: number): void {
    if (!this.timeStart) {
      this.timeStart = now();
    }
    const bytesPushed = this.pdfGen.bytesWritten();
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
    this.pixelBytesFactor = this.pdfGen.bytesWritten() / this.pixelsWritten;
  }
}

export async function convertManifest(
  /* eslint-disable  @typescript-eslint/explicit-module-boundary-types */
  manifestJson: any,
  outputStream: Writable | FileSystemWritableFileStream,
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
  // Wrap web streams in an adpater class that maps to the node Writable
  // interface
  if (typeof (outputStream as WritableStream).close === 'function') {
    outputStream = new WritableAdapter(
      outputStream as FileSystemWritableFileStream
    );
  } else {
    // Cancel further processing once the underlying stream has been closed
    // This will only have an effect if the PDF has not finished generating
    // yet (i.e. when the client terminates the connection prematurely),
    // otherwise all processing will long have stopped
    (outputStream as Writable).on('close', () => cancelToken.requestCancel());
  }
  const countingStream = new CountingWritable(outputStream as Writable);

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
  const pdfGen = new PDFGenerator(countingStream, pdfMetadata);

  const canvases = manifest
    .getSequenceByIndex(0)
    .getCanvases()
    .filter((c) => canvasPredicate(c.id));
  const labels = canvases.map(
    (canvas) => canvas.getLabel().getValue(languagePreference as string[]) ?? ''
  );
  pdfGen.setPageLabels(labels);

  /// PDF Outline nodes associated with each IIIF Range
  const rangeOutlines: { [rangeId: string]: PDFKit.PDFOutline } = {};
  const { rangeParents, canvasRanges } = buildPdfTocFromRanges(
    manifest,
    canvases,
    languagePreference as string[]
  );

  const progress = new ProgressTracker(
    canvases, countingStream, pdfGen, onProgress);
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
        pdfGen.renderPage({ width, height }, data!, ppi);
        progress.updatePixels(width * height, canvas.getWidth() * canvas.getHeight());
      }
    } catch (err) {
      // Clear queue, cancel all oingoing image fetching
      console.error(err);
      queue.clear();
      await cancelToken.requestCancel();
      throw err;
    }

    const rangeInfo = canvasRanges[canvas.id];
    if (rangeInfo) {
      const { label: rangeLabel, id: rangeId } = rangeInfo;
      const parentId = rangeParents[rangeId]?.[0];
      let parentOutline;
      if (parentId) {
        parentOutline = rangeOutlines[parentId];
      }
      rangeOutlines[rangeId] = pdfGen.addTocItem(rangeLabel, parentOutline);
    }
    progress.emitProgress(canvasIdx + 1);
  }

  // Promise that allows us to wait for the underlying output stream to be closed
  const closePromise: Promise<void> = new Promise((fullfill) =>
    (outputStream as Writable).once('close', () => {
      fullfill();
    })
  );
  pdfGen.close();

  // All bytes have been pushed, we can set the estimated file size
  // to the actual number of bytes that were pushed and wait for
  // the close event on the output stream.
  if (!cancelToken.cancelled) {
    (outputStream as Writable).on('drain', () => progress.emitProgress(canvases.length));
  }
  await closePromise;
}
