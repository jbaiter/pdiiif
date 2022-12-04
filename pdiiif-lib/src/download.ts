/* eslint-disable @typescript-eslint/no-non-null-assertion */
import fetch from 'cross-fetch';
import { minBy } from 'lodash-es';
import { Mutex } from 'async-mutex';
import {
  AnnotationNormalized,
  CanvasNormalized,
  ContentResource,
  FragmentSelector,
  IIIFExternalWebResource,
  ImageService,
  ImageService3,
  InternationalString,
  ManifestNormalized,
  RangeNormalized,
  Reference,
  Selector,
  Service,
} from '@iiif/presentation-3';

import { OcrPage, fetchAndParseText } from './ocr.js';
import metrics from './metrics.js';
import log from './log.js';
import {
  vault,
  isPhysicalDimensionService,
  PhysicalDimensionService,
  supportsScaling,
  fetchFullImageService,
  getCanvasAnnotations,
  Annotation,
  getAllPaintingAnnotations,
  extractChoices,
} from './iiif.js';
import { isDefined } from './util.js';
import { SingleChoice } from '@iiif/vault-helpers/painting-annotations';

/// In absence of more detailed information (from physical dimensions service), use this resolution
const FALLBACK_PPI = 300;

/** Maps rate-limited hosts to a mutex that limits the concurrent fetching. */
class RateLimitingRegistry {
  private hostMutexes = new Map<string, Mutex>();
  private callbacks: Array<(host: string, limited: boolean) => void> = [];

  getMutex(host: string): Mutex | undefined {
    return this.hostMutexes.get(host);
  }

  limitHost(host: string): Mutex {
    const mutex = new Mutex();
    this.hostMutexes.set(host, mutex);
    this.callbacks.forEach((cb) => cb(host, true));
    return mutex;
  }

  unlimitHost(host: string): void {
    this.hostMutexes.delete(host);
    this.callbacks.forEach((cb) => cb(host, false));
  }

  subscribe(cb: (host: string, limited: boolean) => void): number {
    this.callbacks.push(cb);
    return this.callbacks.length - 1;
  }

  unsubscribe(ticket: number) {
    this.callbacks.splice(ticket, 1);
  }

  isLimited(url: string): boolean {
    return this.hostMutexes.has(new URL(url).host);
  }
}

export const rateLimitRegistry = new RateLimitingRegistry();

/** A 'respectful' wrapper around `fetch` that tries to respect rate-limiting headers.
 *
 * Will also retry with exponential backoff in case of server errors.
 */
export async function fetchRespectfully(
  url: string,
  init?: RequestInit,
  maxRetries = 3
): Promise<Response> {
  const { host } = new URL(url);
  // If the host associated with the URL is rate-limited, limit concurrency to a single
  // fetch at a time by acquiring the mutex for the host.
  let rateLimitMutex = rateLimitRegistry.getMutex(host);
  let numRetries = -1;
  let resp: Response | undefined;
  let waitMs = 1000;
  let lastError: unknown;
  // If we're fetching from a rate-limited host, wait until there's no other fetch for it
  // going on
  const release = await rateLimitMutex?.acquire();
  try {
    do {
      try {
        resp = await fetch(url, init);
        if (resp.ok) {
          break;
        }
      } catch (e) {
        log.error(`Error fetching ${url}: ${e}`);
        lastError = e;
        resp = undefined;
      }
      numRetries++;

      const retryAfter = resp?.headers.get('retry-after');
      if (isDefined(retryAfter)) {
        if (Number.isInteger(retryAfter)) {
          waitMs = Number.parseInt(retryAfter, 10) * 1000;
        } else {
          const waitUntil = Date.parse(retryAfter);
          waitMs = waitUntil - Date.now();
        }
      } else {
        // Exponential backoff with a random multiplier on the base wait time
        waitMs = Math.pow(Math.random() * 2 * waitMs, numRetries);
      }

      // Check if the server response has headers corresponding to the IETF `RateLimit Header Fiels for HTTP` spec draft[1]
      // [1] https://www.ietf.org/archive/id/draft-polli-ratelimit-headers-05.html
      const getHeaderValue = (ietfHeader: string): number | undefined => {
        const headerVariants = [
          ietfHeader,
          `x-${ietfHeader}`,
          `x-${ietfHeader.replace('ratelimit', 'rate-limit')}`,
        ];
        return headerVariants
          .map((header) => resp?.headers.get(header))
          .filter(isDefined<string>)
          .map((limit) => Number.parseInt(limit, 10))
          .find((limit) => limit != null);
      };
      const limit = getHeaderValue('ratelimit-limit');
      const remaining = getHeaderValue('ratelimit-remaining');
      const reset = getHeaderValue('ratelimit-reset');
      if (
        limit !== undefined &&
        remaining !== undefined &&
        reset !== undefined
      ) {
        // At this point we're pretty sure that we're being rate-limited, so let's
        // limit concurrency from here on out.
        rateLimitMutex = rateLimitRegistry.limitHost(host);

        // We assume a sliding window implemention here
        const secsPerQuotaUnit = reset / (limit - remaining);
        if (remaining > 0) {
          // If we have remaining quota units but were blocked, we wait until we have enough
          // quota to fetch remaining*2 quota units (i.e. we assume that the units in `remaining`
          // were not enough to fully fetch the resource)
          waitMs = 2 * remaining * secsPerQuotaUnit * 1000;
        } else {
          waitMs = secsPerQuotaUnit * 1000;
        }
      }

      // Add a 100ms buffer just to be safe and wait until the next attempt
      await new Promise((resolve) => setTimeout(resolve, waitMs + 100));
    } while (numRetries < maxRetries);
  } finally {
    if (rateLimitMutex) {
      // We're being rate-limited, so wait some more so the next request doesn't
      // encounter a server error on fetching
      await new Promise((resolve) => setTimeout(resolve, waitMs + 100));
    }
    release?.();
  }
  if (!resp) {
    throw lastError;
  }
  return resp;
}

/** Container for image size along with its corresponding IIIF Image API string. */
export type SizeInfo = {
  iiifSize: string;
  width: number;
  height: number;
};

/** Calculate the image size to fetch, based on user constraints and available sizes
 *  in the Image API info.json response.
 */
export function getImageSize(
  imgService: ImageService,
  scaleFactor = 1
): SizeInfo {
  let sizeStr: string;
  const isIIIFv3 = (imgService as ImageService3).id !== undefined;
  const maxWidth = imgService.maxWidth ?? imgService.width!;
  let requestedWidth = Math.floor(scaleFactor * maxWidth);
  const aspectRatio = imgService.width! / imgService.height!;
  const supportsScaleByWh = Array.isArray(imgService.profile)
    ? imgService.profile.find(supportsScaling) !== undefined
    : supportsScaling(imgService.profile);
  if (scaleFactor < 1 && !supportsScaleByWh) {
    if (imgService.sizes) {
      // AR-compliant downscaling is not supported, find the closest available size
      requestedWidth = minBy(
        imgService.sizes.map((dims) => Math.abs(requestedWidth - dims.width))
      )!;
      sizeStr = `${requestedWidth},`;
    } else {
      // No sizes available, so we can't downscale.
      sizeStr = `${maxWidth},`;
    }
  } else if (scaleFactor == 1) {
    sizeStr =
      isIIIFv3 || imgService.maxWidth || imgService.maxArea ? 'max' : 'full';
    if (imgService.maxWidth) {
      requestedWidth = imgService.maxWidth;
    } else if (imgService.maxHeight) {
      requestedWidth = Math.round(aspectRatio * imgService.maxHeight);
    } else if (imgService.maxArea) {
      const fullArea = imgService.width! * imgService.height!;
      const scaleFactor = imgService.maxArea / fullArea;
      requestedWidth = Math.round(scaleFactor * imgService.width!);
    } else {
      requestedWidth = imgService.width!;
    }
  } else {
    sizeStr = `${requestedWidth},`;
  }
  return {
    iiifSize: sizeStr,
    width: requestedWidth as number,
    height: (requestedWidth as number) / aspectRatio,
  };
}

/** Use a IIIF Physical Dimensions service to obtain the PPI for a canvas. */
export function getPointsPerInch(services: Service[]): number | null {
  const physDimService = services.find(isPhysicalDimensionService) as
    | PhysicalDimensionService
    | undefined;
  if (!physDimService) {
    return null;
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
  return ppi;
}

/** All the data relevant for the canvas: images and text
 *
 * TODO: Should annotations also be a part of this?
 */
export type CanvasData = {
  canvas: Reference<'Canvas'>;
  text?: OcrPage;
  images: CanvasImage[];
  annotations: Annotation[];
  ppi?: number;
};

/** An image on a canvas, optionally with its image data */
export type CanvasImage = {
  data?: ArrayBuffer;
  location: { x: number; y: number };
  dimensions: { width: number; height: number };
  ppi?: number;
  numBytes: number;
  // These two are set when the image is part of a `Choice` body on
  // an annotation
  isOptional: boolean;
  visibleByDefault: boolean;
  label?: InternationalString;
};

/** Options for fetching image */
export type FetchImageOptions = {
  /// Factor to downscale the image by, number between 0.1 and 1
  scaleFactor?: number;
  /// PPI override, will be fetched from physical dimensions serivce by default
  ppiOverride?: number;
  // Optional signal to use for aborting the image fetching
  abortSignal?: AbortSignal;
  /// Only obtain the size of the image, don't fetch any data
  sizeOnly?: boolean;
};

async function fetchCanvasImage(
  imgAnno: AnnotationNormalized,
  { scaleFactor, abortSignal, sizeOnly = false }: FetchImageOptions
): Promise<CanvasImage | null> {
  if (abortSignal?.aborted) {
    log.debug(
      'Abort signalled, aborting before initiating image data fetching.'
    );
    return null;
  }
  if (typeof imgAnno.target !== 'string') {
    log.error(
      `Target for image annotation ${imgAnno.id} is not a string, currently unsupported!`
    );
  }
  const target = imgAnno.target as string;
  let location: { x: number; y: number };
  let dimensions: { width: number; height: number };
  const [canvasId, fragment] = target.split('#xywh=');
  const canvas = vault.get<CanvasNormalized>(canvasId);
  if (fragment) {
    const [x, y, width, height] = fragment
      .split(',')
      .map((x) => parseInt(x, 10));
    location = { x, y };
    dimensions = { width, height };
  } else {
    location = { x: 0, y: 0 };
    dimensions = { width: canvas.width, height: canvas.height };
  }
  const image = vault
    .get<ContentResource>(imgAnno.body)
    .find(
      (r: ContentResource): r is IIIFExternalWebResource => r.type === 'Image'
    );
  if (!image) {
    log.error(`No image for annotation ${imgAnno.id} found!`);
    return null;
  }
  let imgService = image.service?.find(
    (s: Service): s is ImageService =>
      ((s as ImageService | undefined)?.type?.startsWith('ImageService') ??
        false) ||
      ((s as any)?.['@type']?.startsWith('ImageService') ?? false)
  );
  let ppi: number | undefined;
  let imageUrl: string;
  if (imgService) {
    if (!imgService.width) {
      imgService = await fetchFullImageService(imgService);
    }
    const sizeInfo = getImageSize(imgService, scaleFactor);
    imageUrl = `${imgService.id ?? imgService['@id']}/full/${
      sizeInfo.iiifSize
    }/0/default.jpg`;
    ppi = getPointsPerInch(imgService.service ?? []) ?? undefined;
    if (ppi) {
      ppi = ppi * (sizeInfo.width / imgService.width!);
    }
  } else if (image.id && image.format === 'image/jpeg') {
    imageUrl = image.id;
  } else {
    log.error(
      `No JPEG image identifier for annotation ${imgAnno.id} could be found!`
    );
    return null;
  }

  let data: ArrayBuffer | undefined;
  let numBytes: number;
  const stopMeasuring = metrics?.imageFetchDuration.startTimer({
    iiif_host: new URL(imageUrl).host,
  });
  try {
    const imgResp = await fetchRespectfully(imageUrl, {
      method: 'GET',
      signal: abortSignal,
    });
    if (imgResp.status >= 400) {
      throw new Error(
        `Failed to fetch page image from ${imageUrl}, server returned status ${imgResp.status}`
      );
    }
    if (abortSignal?.aborted) {
      log.debug('Abort signalled, aborting before fetching image data.');
      return null;
    }
    numBytes = Number.parseInt(imgResp.headers.get('Content-Length') ?? '-1');
    data = sizeOnly && numBytes >= 0 ? undefined : await imgResp.arrayBuffer();
    if (numBytes < 0) {
      numBytes = data?.byteLength ?? -1;
    }
    stopMeasuring?.({
      status: 'success',
      limited: rateLimitRegistry.isLimited(imageUrl).toString(),
    });
  } catch (err) {
    stopMeasuring?.({
      status: 'error',
      limited: rateLimitRegistry.isLimited(imageUrl).toString(),
    });
    if ((err as Error).name !== 'AbortError') {
      log.error(`Failed to fetch image data from ${imageUrl}: ${err}`);
    }
    return null;
  }

  return {
    data,
    location,
    dimensions,
    ppi,
    numBytes,
    isOptional: false,
    visibleByDefault: true,
  };
}

export type StartCanvasInfo =
  | string
  | {
      id: string;
      ppi: number;
      dimensions: { width: number; height: number };
      position: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
    };

export async function fetchStartCanvasInfo(
  resource: ManifestNormalized | RangeNormalized
): Promise<StartCanvasInfo | undefined> {
  const startRef = resource.start;
  if (!startRef) {
    return;
  }
  let canvasId: string | undefined;
  let fragment: string | undefined;
  if (typeof startRef === 'string') {
    const [ident, selectorStr] = (startRef as string).split('#xywh=');
    if (!selectorStr) {
      return ident;
    }
    canvasId = ident;
    fragment = `xywh=${selectorStr}`;
  } else if (startRef.type === 'Canvas') {
    return startRef.id;
  } else {
    const selector = vault.get<Selector>(startRef);
    if (typeof selector === 'string' || selector.type !== 'FragmentSelector') {
      console.warn(
        `Unsupported selector type, cannot determine start canvas for ${resource.id}`
      );
      return;
    }
    const fragSel = selector as FragmentSelector;
    if (fragSel.conformsTo !== 'http://www.w3.org/TR/media-frags/') {
      console.warn(
        `Unsupported selector type, cannot determine start canvas for ${resource.id} (fragment selector type was ${fragSel.conformsTo})`
      );
      return;
    }
    canvasId = fragSel.value;
  }
  if (!fragment || !canvasId) {
    console.error(
      `Couldn't parse either canvas identifier or selector for ${resource.id} start canvas.`
    );
    return;
  }
  const [selX, selY, selWidth, selHeight] = fragment
    .substring(5)
    .split(',')
    .map((v) => Number.parseInt(v, 10));
  const canvas = vault.get<CanvasNormalized>(canvasId);
  const ppi = getPointsPerInch(canvas.service) ?? FALLBACK_PPI;
  return {
    id: canvasId,
    ppi,
    dimensions: { width: canvas.width, height: canvas.height },
    position: {
      x: selX,
      y: selY,
      width: selWidth,
      height: selHeight,
    },
  };
}

export async function fetchCanvasData(
  canvas: CanvasNormalized,
  { scaleFactor, ppiOverride, abortSignal, sizeOnly = false }: FetchImageOptions
): Promise<CanvasData | undefined> {
  const paintingAnnos = getAllPaintingAnnotations(canvas);
  // FIXME: Refactor this shameful abomination
  const images = (
    await Promise.all(
      paintingAnnos.flatMap(async (anno) => {
        const body = vault.get<ContentResource>(anno.body);
        const out: Array<CanvasImage> = [];

        // Fetch image from top-level image resource
        if (body.some((r) => r.type === 'Image')) {
          const img = await fetchCanvasImage(anno, {
            scaleFactor,
            abortSignal,
            sizeOnly,
          });
          if (img) {
            out.push(img);
          }
        }

        // Fetch images from choices in parallel
        const choice = extractChoices(paintingAnnos);
        if (choice?.type === 'single-choice') {
          (
            await Promise.all(
              (choice as SingleChoice).items
                .map((i) => ({
                  res: vault.get<ContentResource>(i.id),
                  selected: i.selected,
                }))
                .filter((res) => res.res.type === 'Image')
                .map(async (res) => {
                  // fetchCanvasImage expects an image annotation, so let's just quickly fake one
                  const img = res.res;
                  const fakeAnno: AnnotationNormalized = {
                    ...anno,
                    body: [{ id: img.id!, type: 'ContentResource' }],
                  };
                  const canvasImg = await fetchCanvasImage(fakeAnno, {
                    scaleFactor,
                    abortSignal,
                    sizeOnly,
                  });
                  if (canvasImg) {
                    canvasImg.isOptional = true;
                    canvasImg.label = (img as any).label;
                    canvasImg.visibleByDefault = res.selected ?? false;
                  }
                  return canvasImg;
                })
            )
          )
            .filter(isDefined<CanvasImage>)
            .forEach((i) => out.push(i));
        }
        return out;
      })
    )
  ).flat();
  const ppi = ppiOverride;
  if (!ppiOverride) {
    let ppi = getPointsPerInch(canvas.service) ?? undefined;
    if (ppi && scaleFactor) {
      ppi = ppi * scaleFactor;
    }
  }
  const text = await fetchAndParseText(canvas, undefined);
  return {
    canvas,
    // FIXME: Shouldn't we signal to the user somehow if some images failed to download?
    images,
    ppi,
    text,
    annotations: getCanvasAnnotations(canvas),
  };
}
