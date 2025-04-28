/// <reference types="wicg-file-system-access"/>
import type { Writable } from 'stream';
import {
  Manifest,
  RangeItems,
  Reference,
  IIIFExternalWebResource,
  ContentResource,
  Service,
  ImageService,
  Annotation as IIIF3Annotation,
} from '@iiif/presentation-3';
import {
  ManifestNormalized,
  CanvasNormalized,
  RangeNormalized,
  AnnotationNormalized,
  ResourceProviderNormalized,
  NormalizedRangeItemSchemas,
} from '@iiif/presentation-3-normalized';
import Presentation2 from '@iiif/presentation-2';
import { upgrade as convertPresentation2 } from '@iiif/parser/upgrader';
import PQueue from 'p-queue';
import events from 'events';
import * as ocrParser from 'ocr-parser';

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
import { getOcrReferences } from './ocr.js';
import pdiiifVersion from './version.js';
import {
  fetchCanvasData,
  fetchRespectfully,
  CanvasData,
  fetchStartCanvasInfo,
  StartCanvasInfo,
  fetchManifestJson,
} from './download.js';
import metrics from './metrics.js';
import { initializeSaxParser, isDefined, now, saxParserWasm } from './util.js';
import log from './log.js';
import {
  getI18nValue,
  getThumbnail,
  getCanvasInfo,
  vault,
  parseAnnotation,
  Annotation,
} from './iiif.js';
import {
  initialize,
  OptimizationParams,
  optimizeImage,
} from './optimization.js';

/** Progress information for rendering a progress bar or similar UI elements. */
export interface ProgressStatus {
  /** Message code that should be mapped to a human readable description in a UI. */
  messageCode?: ProgressMessageCode;
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
  /** Callback that gets called with a notification when an error occurs during PDF generation
   *  that does not cause the conversion to fail. */
  onNotification?: (notification: ProgressNotification) => void;
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
  /** Custom loader callback that fetches the WASM binary for the `sax-wasm`
   *  dependency (v2.2.4). By default, the dependency will be loaded from
   *  `https://unpkg.com/sax-wasm/dist/sax-wasm.wasm`. Override if you want
   *  to provide your own payload. Loader will not be called if {@link initialize}
   *  from `ocr-parser` has been called before.
   */
  saxWasmLoader?: () => Promise<Uint8Array>;
  /** Custom loader callback that fetches the WASM binary for the `@jsquash/jpeg`
   * dependency (v1.5.0). By default the dependency will be loaded from
   * `https://unpkg.com/@jsquash/jpeg@1.5.0/codec/enc/mozjpeg_enc.wasm`. Override
   * if you want to provide your own payload. Loader will not be called if
   * {@link optimization} is not set to use the `mozjpeg` method.
   */
  mozjpegWasmLoader?: () => Promise<Uint8Array>;
  /** Parameters for optimizing the images for size by re-encoding them to JPEGs. */
  optimization?: OptimizationParams;
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
  /** Parameters for optimizing the images for size by re-encoding them to JPEGs. */
  optimization?: OptimizationParams;
  /** Custom loader callback that fetches the WASM binary for the `sax-wasm`
   *  dependency (v2.2.4). By default, the dependency will be loaded from
   *  `https://unpkg.com/sax-wasm/dist/sax-wasm.wasm`. Override if you want
   *  to provide your own payload. Loader will not be called if {@link initialize}
   *  from `ocr-parser` has been called before.
   */
  saxWasmLoader?: () => Promise<Uint8Array>;
  /** Custom loader callback that fetches the WASM binary for the `@jsquash/jpeg`
   * dependency (v1.5.0). By default the dependency will be loaded from
   * `https://unpkg.com/@jsquash/jpeg@1.5.0/codec/enc/mozjpeg_enc.wasm`. Override
   * if you want to provide your own payload. Loader will not be called if
   * {@link optimization} is not set to use the `mozjpeg` method.
   */
  mozjpegWasmLoader?: () => Promise<Uint8Array>;
  /** Pre-sampled list of canvases to use for estimating the size */
  sampleCanvases?: CanvasNormalized[];
}

export type Estimation = {
  /** Estimated size of the PDF in bytes */
  size: number;
  /** If CORS is enabled for all of the images referenced in the sample canvases */
  corsSupported: boolean;
  /** Image data for a sample image, present when optimization is enabled. */
  sampleImageData?: Uint8Array;
  /** Image MIME type for a sample image, present when optimization is enabled. */
  sampleImageMimeType?: string;
  /** How large is the PDF after the image optimization, compared to the unoptimized images?  */
  optimizationResult?: number;
  /** Canvases that were used for estimating */
  sampleCanvases: CanvasNormalized[];
};

function getCanvasesForSampling(
  canvases: CanvasNormalized[],
  numSamples: number
): CanvasNormalized[] {
  if (canvases.length <= numSamples) {
    return canvases;
  }
  const meanPixels =
    canvases.reduce((x, { width, height }) => x + width * height, 0) /
    canvases.length;
  const candidateCanvases = canvases.filter(
    (c) => Math.abs(meanPixels - c.width * c.height) <= 0.25 * meanPixels
  );
  if (candidateCanvases.length <= numSamples) {
    return candidateCanvases;
  }
  const sampleCanvases: CanvasNormalized[] = [];
  while (sampleCanvases.length < numSamples) {
    const candidate =
      candidateCanvases[Math.floor(Math.random() * candidateCanvases.length)];
    if (sampleCanvases.indexOf(candidate) < 0) {
      sampleCanvases.push(candidate);
    }
  }
  return sampleCanvases.sort(
    (a, b) => canvases.indexOf(a) - canvases.indexOf(b)
  );
}

/** Estimate the final size of the PDF for a given manifest.
 *
 * This will randomly sample a few representative canvases from the manifest,
 * check their size in bytes and extrapolate from that to all canvases.
 *
 * @throws {Error} if the manifest cannot be loaded
 */
export async function estimatePdfSize({
  manifest: inputManifest,
  concurrency = 1,
  scaleFactor,
  filterCanvases = () => true,
  numSamples = 8,
  optimization,
  saxWasmLoader = async () =>
    fetch(
      `https://unpkg.com/sax-wasm@${ocrParser.SAX_WASM_VERSION}/lib/sax-wasm.wasm`
    )
      .then((res) => res.arrayBuffer())
      .then((buf) => new Uint8Array(buf)),
  mozjpegWasmLoader = async () =>
    fetch('https://unpkg.com/@jsquash/jpeg@1.5.0/codec/enc/mozjpeg_enc.wasm')
      .then((res) => res.arrayBuffer())
      .then((buf) => new Uint8Array(buf)),
  sampleCanvases
}: EstimationParams): Promise<Estimation> {
  let manifestId;
  if (typeof inputManifest === 'string') {
    manifestId = inputManifest;
  } else {
    manifestId =
      (inputManifest as Manifest).id ??
      (inputManifest as Presentation2.Manifest)['@id'];
  }
  const manifestJson = await fetchManifestJson(manifestId);
  const manifest = await vault.loadManifest(manifestId, manifestJson);
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
    manifest.items.filter(c => canvasPredicate(c.id)).map(c => c.id));

  // Select some representative canvases that are close to the mean in terms
  // of their pixel area to avoid small images distorting the estimate too much
  const totalCanvasPixels = canvases.reduce(
    (sum, canvas) => sum + canvas.width * canvas.height,
    0
  );
  if (!sampleCanvases?.length) {
    sampleCanvases = getCanvasesForSampling(canvases, numSamples);
  }
  const samplePixels = sampleCanvases.reduce(
    (sum, canvas) => sum + canvas.width * canvas.height,
    0
  );

  // Initialize XML parsers
  if (!saxParserWasm || !ocrParser.isInitialized()) {
    if (!saxParserWasm) {
      const wasm = await saxWasmLoader();
      initializeSaxParser(wasm);
    }
    if (!ocrParser.isInitialized()) {
      await ocrParser.initialize(() => Promise.resolve(saxParserWasm!));
      ocrParser.setupLogging({
        debug: log.debug.bind(log),
        info: log.info.bind(log),
        warn: log.warn.bind(log),
        error: log.error.bind(log),
      });
    }
  }

  const queue = new PQueue({ concurrency });
  const canvasData = await Promise.all(
    sampleCanvases.map((c) =>
      queue.add(async () => {
        const info = getCanvasInfo(c);
        return fetchCanvasData(c, info.images, {
          scaleFactor,
          sizeOnly: optimization === undefined,
        });
      })
    )
  );

  let optimizationResult: number | undefined;
  if (optimization) {
    if (optimization.method === 'mozjpeg') {
      await initialize(mozjpegWasmLoader);
    }
    const images = canvasData
      .filter((c): c is CanvasData => c !== undefined)
      .flatMap((c) => c.images);
    const originalSize = images.reduce(
      (sum, img) => sum + img.data!.byteLength,
      0
    );
    await Promise.all(
      images.map(async (img) => {
        const optimized = await optimizeImage({
          imageData: new Uint8Array(img.data!),
          imageFormat:
            (img.format as 'jpeg' | 'png') === 'jpeg'
              ? 'image/jpeg'
              : 'image/png',
          ...optimization,
        });
        img.data = optimized.jpegData.buffer;
        img.format = 'jpeg';
      })
    );
    const optimizedSize = images.reduce(
      (sum, img) => sum + img.data!.byteLength,
      0
    );
    optimizationResult = optimizedSize / originalSize;
  }

  const corsSupported = canvasData
    .filter(isDefined<CanvasData>)
    .flatMap((c) => c.images)
    .every((i) => i.corsAvailable);
  const sampleBytes = canvasData
    .filter(isDefined<CanvasData>)
    .flatMap((c) => c.images)
    .reduce(
      (size: number, img) => size + (img?.data?.byteLength ?? img.numBytes),
      0
    );
  const sampleImages = canvasData
    .filter(isDefined<CanvasData>)
    .flatMap((c) => c.images);
  const sampleImage = sampleImages[0];
  const bpp = sampleBytes / samplePixels;
  return {
    size: bpp * totalCanvasPixels,
    corsSupported,
    sampleImageData: sampleImage.data
      ? new Uint8Array(sampleImage.data)
      : undefined,
    sampleImageMimeType: sampleImage.format,
    sampleCanvases,
    optimizationResult
  };
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
  // Note that this is a *filtered* list of canvases, i.e. if the user only selected a subset of the
  // canvases for PDF generation, not every Range in the manifest will have all of its canvases in here
  const canvasIds = canvases.map((canvas) => canvas.id);

  // We have to recurse, this small closure handles each node in the tree
  const isCanvas = (ri: RangeItems | NormalizedRangeItemSchemas): ri is Reference<'Canvas'> =>
    typeof ri !== 'string' && ri.type === 'Canvas';
  const isRange = (ri: RangeItems | NormalizedRangeItemSchemas): ri is Reference<'Range'> =>
    typeof ri !== 'string' && ri.type == 'Range';

  const seenRanges: Set<string> = new Set();
  const handleTocRange = async (
    range: RangeNormalized
  ): Promise<TocItem | undefined> => {
    if (seenRanges.has(range.id)) {
      return;
    }
    // Double filtering with `isCanvas` is necessary because of TS limitations
    const firstCanvas = range.items
      .filter(isCanvas)
      .filter((c) => canvasIds.indexOf(c.id!) >= 0)
      .filter(isCanvas)
      .sort((a, b) =>
        canvasIds.indexOf(a.id!) > canvasIds.indexOf(b.id!) ? -1 : 1
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
    seenRanges.add(range.id);
    if (children.length === 0 && !firstCanvas) {
      // Range with no canvases and no child ranges, ignore
      // This usually happens when the user filtered the canvases to be included in the
      // PDF and the range and its children only contains canvases that were filtered out
      return;
    } else if (!startCanvas && firstCanvas) {
      startCanvas = firstCanvas.id;
    } else if (!startCanvas) {
      startCanvas = children[0].startCanvas;
    }
    return {
      label: rangeLabel,
      startCanvas: startCanvas!,
      children,
    };
  };

  let tocRanges = vault.get<RangeNormalized>(manifest.structures);
  const topRange = tocRanges.find(
    (r) => (r.behavior as string[]).indexOf('top') >= 0
  );
  // If there's a 'top' range, only use that as the single top-level ToC node
  if (topRange) {
    tocRanges = [topRange];
  }

  return (
    (await Promise.all(tocRanges.map(handleTocRange))).filter(
      isDefined<TocItem>
    ) ?? []
  );
}

export type ProgressMessageCode =
  | 'generate-cover-page'
  | 'generate-pages'
  | 'finishing';

export type ProgressNotification =
  | ImageDownloadFailureNotification
  | OcrDownloadFailureNotification;

export type ImageDownloadFailureNotification = {
  code: 'image-download-failure';
  canvasIndex: number;
  numFailed: number;
  numTotal: number;
  details: {
    [imageUrl: string]: string;
  };
};
export type OcrDownloadFailureNotification = {
  code: 'ocr-download-failure';
  canvasIndex: number;
  ocrUrl: string;
};

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
  onNotification?: (notification: ProgressNotification) => void;

  constructor(
    canvases: CanvasNormalized[],
    countingStream: CountingWriter,
    pdfGen: PDFGenerator,
    onProgress?: (status: ProgressStatus) => void,
    onNotification?: (notification: ProgressNotification) => void
  ) {
    this.totalCanvasPixels = canvases.reduce(
      (sum, canvas) => sum + canvas.width * canvas.height,
      0
    );
    this.totalPages = canvases.length;
    this.pdfGen = pdfGen;
    this.countingStream = countingStream;
    this.onProgress = onProgress;
    this.onNotification = onNotification;
  }

  /** Check if there is still data that needs to be written out. */
  get writeOutstanding(): boolean {
    return this.pdfGen.bytesWritten > this.countingStream.bytesWritten;
  }

  /** Emit a progress update, with an optional message. */
  emitProgress(pagesWritten: number, messageCode?: ProgressMessageCode): void {
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
      messageCode,
      pagesWritten,
      totalPages: this.totalPages,
      bytesWritten,
      bytesPushed,
      estimatedFileSize,
      writeSpeed,
      remainingDuration,
    });
  }

  /** Emit a notification message to inform the user about unexpected stuff that
   * happens during PDF generation */
  emitNotification(notification: ProgressNotification) {
    this.onNotification?.(notification);
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
    const manifestThumb = vault.get<ContentResource>(manifest.thumbnail.map(t => t.id))[0];
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
      homepage: provider.homepage?.[0]?.id,
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
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(params),
    });
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  } else {
    throw 'Either `endpoint` or `callback` must be specified!';
  }
}

export type ConversionReport = {
  fileSizeBytes: number;
  numPages: number;
  fileName?: string;
  failedImages?: Array<{
    canvasIndex: number;
    numFailed: number;
    numTotal: number;
    details: {
      [imageUrl: string]: string;
    };
  }>;
  failedOcr?: Array<{
    canvasIndex: number;
    ocrUrl: string;
  }>;
};

export type ConversionReportWithData = ConversionReport & { data: Blob };

export async function convertManifest(
  inputManifest: string | Manifest | Presentation2.Manifest,
  outputStream: Writable | WritableStream,
  options: ConvertOptions
): Promise<ConversionReport>;
export async function convertManifest(
  inputManifest: string | Manifest | Presentation2.Manifest,
  outputStream: undefined,
  options: ConvertOptions
): Promise<ConversionReportWithData>;
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
    onNotification,
    ppi,
    concurrency = 1,
    abortController = new AbortController(),
    coverPageCallback,
    coverPageEndpoint,
    polyglotZipPdf,
    polyglotZipBaseDir,
    optimization,
    saxWasmLoader = async () =>
      fetch(
        `https://unpkg.com/sax-wasm@${ocrParser.SAX_WASM_VERSION}/lib/sax-wasm.wasm`
      )
        .then((res) => res.arrayBuffer())
        .then((buf) => new Uint8Array(buf)),
    mozjpegWasmLoader = async () =>
      fetch('https://unpkg.com/@jsquash/jpeg@1.5.0/codec/enc/mozjpeg_enc.wasm')
        .then((res) => res.arrayBuffer())
        .then((buf) => new Uint8Array(buf)),
  }: ConvertOptions
): Promise<ConversionReport | ConversionReportWithData> {
  // Prevent warning when running in Node.js
  if (typeof process !== 'undefined') {
    events.setMaxListeners(100, abortController.signal);
  }
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
  const report = {
    fileSizeBytes: 0,
    numPages: 0,
  } as ConversionReport;

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
    manifestJson = (await fetchManifestJson(manifestId)) as
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
  const hasText = !!canvases.find((c) => !!getOcrReferences(c));
  const labels = canvases.map((canvas) =>
    canvas.label ? getI18nValue(canvas.label, languagePreference, '; ') : ''
  );

  // Initialize XML parsers
  if (!saxParserWasm || !ocrParser.isInitialized()) {
    if (!saxParserWasm) {
      const wasm = await saxWasmLoader();
      initializeSaxParser(wasm);
    }
    if (!ocrParser.isInitialized()) {
      await ocrParser.initialize(() => Promise.resolve(saxParserWasm!));
      ocrParser.setupLogging({
        debug: log.debug.bind(log),
        info: log.info.bind(log),
        warn: log.warn.bind(log),
        error: log.error.bind(log),
      });
    }
  }

  // Fetch images concurrently, within limits specified by user
  log.debug(`Setting up queue with ${concurrency} concurrent canvas fetches.`);
  const queue = new PQueue({ concurrency });
  abortController.signal.addEventListener('abort', () => queue.clear(), {
    once: true,
  });
  const canvasInfos = canvases.map(getCanvasInfo);
  const canvasFuts = canvases.map((c, idx) => {
    return queue.add(async () => {
      const info = canvasInfos[idx];
      const canvasData = await fetchCanvasData(c, info.images, {
        scaleFactor,
        ppiOverride: ppi,
        abortSignal: abortController.signal,
      });
      // TODO: If downscaling was not possible due to lack of IIIF Image API support,
      //       we should force an optimization pass with a lower resolution.
      if (optimization) {
        await Promise.all(
          canvasData?.images.map(async (i) => {
            const optimized = await optimizeImage({
              imageData: new Uint8Array(i.data!),
              imageFormat: i.format === 'jpeg' ? 'image/jpeg' : 'image/png',
              ...optimization,
            });
            log.debug('main: Got optimized image', i.resource.id);
            i.data = optimized.jpegData;
            i.format = 'jpeg';
          }) ?? []
        );
      }
      return canvasData;
    });
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
      ...canvasInfos[idx],
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
    onProgress,
    onNotification
  );
  progress.emitProgress(0);

  if (coverPageCallback || coverPageEndpoint) {
    log.debug(`Generating cover page`);
    progress.emitProgress(0, 'generate-cover-page');
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

  progress.emitProgress(0, 'generate-pages');
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
      const canvasInfo = canvasInfos[canvasIdx];
      const { images, ppi, text, annotations, imageFailures } = canvasData;
      if (imageFailures.length > 0) {
        if (!report.failedImages) {
          report.failedImages = [];
        }
        const reportData = {
          canvasIndex: canvasIdx,
          numFailed: imageFailures.length,
          numTotal: images.length + imageFailures.length,
          details: Object.fromEntries(
            imageFailures.map((f) => [
              f.resource.id ?? '<unknown>',
              f.cause instanceof Error ? f.cause.toString() : f.cause,
            ])
          ),
        };
        report.failedImages.push(reportData);
        progress.emitNotification({
          code: 'image-download-failure',
          ...reportData,
        });
      }
      if (canvasInfo.ocr && !text?.markup) {
        if (!report.failedOcr) {
          report.failedOcr = [];
        }
        const reportData = {
          canvasIndex: canvasIdx,
          ocrUrl: canvasInfo.ocr.id,
        };
        report.failedOcr.push(reportData);
        progress.emitNotification({
          code: 'ocr-download-failure',
          ...reportData,
        });
      }
      const externalAnnotations = await fetchCanvasAnnotations(canvas.id);
      if (externalAnnotations != null) {
        const normalized = await Promise.all(
          externalAnnotations.map((a) => {
            if (!('id' in a)) {
              a = convertPresentation2(a) as unknown as IIIF3Annotation;
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
        [...images, ...imageFailures],
        annotations,
        text,
        ppi
      );
      stopMeasuring?.();
      progress.updatePixels(
        images.reduce((acc, img) => acc + img.width * img.height, 0),
        canvas.width * canvas.height
      );
      report.numPages++;
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
    const progressOnDrain = async () => {
      if (closed) {
        return;
      }
      progress.emitProgress(canvases.length, 'finishing');
      while (!closed && progress.writeOutstanding) {
        await writer.waitForDrain();
      }
    };

    // Wait for initial drainage event in case the writer isn't already closed
    if (!closed) {
      await writer.waitForDrain();
      await progressOnDrain();
    }
  }

  // Wait for the writer to be closed
  log.debug('Waiting for writer to close.');
  await endPromise;

  report.fileSizeBytes = countingWriter.bytesWritten;
  if (writer instanceof BlobWriter) {
    return { ...report, data: writer.blob };
  } else {
    return report;
  }
}
