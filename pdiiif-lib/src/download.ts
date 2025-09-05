/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Mutex } from 'async-mutex';
import {
  ExternalWebResource,
  FragmentSelector,
  IIIFExternalWebResource,
  ImageService,
  ImageService3,
  Reference,
  Selector,
  Service,
} from '@iiif/presentation-3';
import {
  CanvasNormalized,
  ManifestNormalized,
  RangeNormalized,
} from '@iiif/presentation-3-normalized'

import { OcrPageWithMarkup, fetchAndParseText } from './ocr.js';
import metrics from './metrics.js';
import log from './log.js';
import {
  vault,
  isPhysicalDimensionService,
  PhysicalDimensionService,
  supportsScaling,
  getCanvasAnnotations,
  Annotation,
  ImageInfo,
} from './iiif.js';
import { isDefined } from './util.js';

/// In absence of more detailed information (from physical dimensions service), use this resolution
const FALLBACK_PPI = 300;

// HTTP Accept header to make sure we get IIIFv3, if available, via content negotiation
// Thanks to @jcoyne:
// https://github.com/ProjectMirador/mirador/pull/3770/files#diff-166256fe28a89c78ada7b08488a3233671fc0511fd39d323c5cfc9433026e2a1R108-R112
const MANIFEST_ACCEPT_HEADER = 'application/ld+json;q=0.9;profile="http://iiif.io/api/presentation/3/context.json", '
  + 'application/ld+json;q=0.7;profile="http://iiif.io/api/presentation/2/context.json", '
  + 'application/ld+json;q=0.5, '
  + 'application/json;q=0.2';

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

/** Tracks for which domains we need and safely can include credentials for */
const includedCredentialsHosts = new Set<string>();

/** Check if requests to the given host should include credentials */
export function requestsShouldIncludeCredentials(host: string): boolean {
  return includedCredentialsHosts.has(host);
}

/** A 'respectful' wrapper around `fetch` that tries to respect rate-limiting headers.
 *
 * Will also retry with exponential backoff in case of server errors.
 */
export async function fetchRespectfully(
  url: string,
  init: RequestInit = {},
  maxRetries = 3
): Promise<Response> {
  const { host } = new URL(url);
  // If the host associated with the URL is rate-limited, limit concurrency to a single
  // fetch at a time by acquiring the mutex for the host.
  let rateLimitMutex = rateLimitRegistry.getMutex(host);
  let numRetries = -1;
  let resp: Response | undefined;
  let waitMs = 5000;
  let fetchOptions = { ...init };
  if (includedCredentialsHosts.has(host)) {
    fetchOptions.credentials = 'include';
  }
  // If we're fetching from a rate-limited host, wait until there's no other fetch for it
  // going on
  const release = await rateLimitMutex?.acquire();
  try {
    do {
      resp = await fetch(url, fetchOptions);
      if (resp.ok) {
        if (fetchOptions.credentials === 'include') {
          // If we successfully fetched with credentials, remember that for next request to that host
          includedCredentialsHosts.add(host);
        }
        break;
      }

      if ((resp.status == 401 || resp.status == 403) && fetchOptions.credentials !== 'include') {
        // Retry with included credentials and don't increment counter
        fetchOptions.credentials = 'include';
        continue;
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
      requestedWidth = Math.min(...imgService.sizes.map((dims) => Math.abs(requestedWidth - dims.width)));
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

export function isImageFetchFailure(obj: CanvasImageData | ImageFetchFailure): obj is ImageFetchFailure {
  return (obj as ImageFetchFailure).cause !== undefined;
}

/** All the data relevant for the canvas: images and text */
export type CanvasData = {
  canvas: Reference<'Canvas'>;
  text?: OcrPageWithMarkup;
  images: CanvasImage[];
  annotations: Annotation[];
  ppi?: number;
  imageFailures: ImageFetchFailure[];
};

export type ImageFetchFailure = ImageInfo & {
  cause: Error | string;
}


/** Data and additional information for an image on a canvas. */
export type CanvasImage = ImageInfo & CanvasImageData;

/** Data and additional info for a canvas image, based on retrieval
 *  of external resources.
 */
export type CanvasImageData = {
  data?: ArrayBuffer;
  numBytes: number;
  format: 'jpeg' | 'png';
  corsAvailable: boolean;
  ppi?: number;
  nativeWidth?: number;
  nativeHeight?: number;
  downscaled?: boolean;
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

/** Download (or only determine size in bytes of) a canvas image. */
async function fetchCanvasImage(
  image: IIIFExternalWebResource | ExternalWebResource,
  { scaleFactor, abortSignal, sizeOnly = false }: FetchImageOptions
): Promise<CanvasImageData | null> {
  // NOTE: Here be dragons, who'd have thought downloading an image
  //       could be so complicated?
  if (abortSignal?.aborted) {
    log.debug(
      'Abort signalled, aborting before initiating image data fetching.'
    );
    throw new Error('Aborted due to client request', { cause: { type: 'abort' } });
  }
  if (image.type !== 'Image') {
    throw new Error(`Can only fetch image resources, got ${image.type}`);
  }
  let imgService: ImageService | undefined;
  if ('service' in image) {
    imgService = image.service?.find(
      (s: Service): s is ImageService =>
        ((s as ImageService | undefined)?.type?.startsWith('ImageService') ??
          false) ||
        ((s as any)?.['@type']?.startsWith('ImageService') ?? false)
    );
  }
  let ppi: number | undefined;
  let imageUrl: string;
  let downscaled = false;
  if (imgService) {
    if (!imgService.width) {
      imgService = await fetchFullImageService(imgService);
    }
    const sizeInfo = getImageSize(imgService, scaleFactor);
    imageUrl = `${imgService.id ?? imgService['@id']}/full/${sizeInfo.iiifSize
      }/0/default.jpg`;
    ppi = getPointsPerInch(imgService.service ?? []) ?? undefined;
    if (ppi) {
      ppi = ppi * (sizeInfo.width / imgService.width!);
    }
    if (sizeInfo.width < imgService.width!) {
      downscaled = true;
    }
  } else if (image.id && ['image/jpeg', 'image/png'].indexOf(image.format ?? 'unknown') >= 0) {
    imageUrl = image.id;
  } else {
    log.error(
      `No JPEG or PNG image identifier for resource ${image.id} could be found!`
    );
    return null;
  }

  let data: ArrayBuffer | undefined;
  let numBytes: number;
  let corsAvailable = true;
  let format: 'jpeg' | 'png' | null = null;
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
        `Failed to fetch page image from ${imageUrl}, server returned status ${imgResp.status}`,
        { cause: { type: 'http-status', status: imgResp.status } }
      );
    }
    if (abortSignal?.aborted) {
      throw new Error('Aborted due to client request', { cause: { type: 'abort' } });
    }
    numBytes = Number.parseInt(imgResp.headers.get('Content-Length') ?? '-1');
    data = sizeOnly && numBytes >= 0 ? undefined : await imgResp.arrayBuffer();
    if (imgResp.headers.get('Content-Type')?.startsWith('image/jpeg')) {
      format = 'jpeg';
    } else if (imgResp.headers.get('Content-Type')?.startsWith('image/png')) {
      format = 'png';
    } else {
      throw new Error('Unsupported image content type', { cause: { type: 'content-type' } });
    }
    if (numBytes < 0) {
      numBytes = data?.byteLength ?? -1;
    }
    stopMeasuring?.({
      status: 'success',
      limited: rateLimitRegistry.isLimited(imageUrl).toString(),
    });
  } catch (err) {
    // In browsers, we can't differentiate between a 'normal' network error
    // (like an unavailable server) and a CORS error just from the response
    // alone, so we we use a small hack involving the DOM
    const isCorsError = typeof document !== 'undefined' && await isImageUnavailableDueToCors(imageUrl);
    // No CORS error or CORS error, but need data? Can't continue
    if (!isCorsError) {
      log.error(`Failed to fetch image data from ${imageUrl}: ${err}`);
      stopMeasuring?.({
        status: 'error',
        limited: rateLimitRegistry.isLimited(imageUrl).toString(),
        cause: err instanceof Error ? (err.cause as any).type : err
      });
      throw err;
    } else if (!sizeOnly) {
      throw new Error('Data requested, but no CORS for the image endpoint', { cause: { type: 'no-cors' } });
    }
    corsAvailable = false;
    log.warn(
      `Failed to fetch image data from ${imageUrl}: CORS headers missing!`
    );
    // We can get the size without CORS
    const imgResp = await fetchRespectfully(imageUrl, {
      method: 'GET',
      signal: abortSignal,
      mode: 'no-cors',
    });
    numBytes = Number.parseInt(imgResp.headers.get('Content-Length') ?? '-1');
  }

  return {
    data,
    ppi,
    numBytes,
    corsAvailable,
    format: format!,
    downscaled,
  };
}

/** Check if an image is unavailable due to missing CORS headers. */
async function isImageUnavailableDueToCors(imageUrl: string): Promise<boolean> {
  const imgElem = document.createElement('img');
  imgElem.src = imageUrl;
  return new Promise((resolve) => {
    // Image loads fine for element => Unavailable due to missing CORS headers
    imgElem.onload = () => resolve(true);
    // Image also errors when loading via element => Server can't be reached
    imgElem.onerror = () => resolve(false);
  });
}

/** Information about the starting canvas of a Manifet or a Range.
 * Can point to a whole canvas or to a part of it. */
export type StartCanvasInfo =
  | string
  | {
    id: string;
    ppi: number;  // Needed to create link in PDF
    dimensions: { width: number; height: number };
    position: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  };

/** Fetch all of the information needed for a start canvas. */
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
  } else if (startRef.type === 'SpecificResource') {
    return startRef.id;
  } else {
    const selector = vault.get<Exclude<Selector, string>>(startRef.id!);
    if (typeof selector === 'string' || selector.type !== 'FragmentSelector') {
      log.warn(
        `Unsupported selector type, cannot determine start canvas for ${resource.id}`
      );
      return;
    }
    const fragSel = selector as FragmentSelector;
    if (fragSel.conformsTo !== 'http://www.w3.org/TR/media-frags/') {
      log.warn(
        `Unsupported selector type, cannot determine start canvas for ${resource.id} (fragment selector type was ${fragSel.conformsTo})`
      );
      return;
    }
    canvasId = fragSel.value;
  }
  if (!fragment || !canvasId) {
    log.error(
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

/** Fetch all of the data associated with a canvas, including external services. */
export async function fetchCanvasData(
  canvas: CanvasNormalized,
  imageInfos: ImageInfo[],
  { scaleFactor, ppiOverride, abortSignal, sizeOnly = false }: FetchImageOptions
): Promise<CanvasData | undefined> {
  const imagePromises = imageInfos.map(i => i.resource).map(r => fetchCanvasImage(r, { scaleFactor, abortSignal, sizeOnly }));
  const results = await Promise.allSettled(imagePromises);
  const canvasImages = results
    .reduce((acc, x, idx) => {
      if (x.status !== 'fulfilled' || x.value === null) {
        return acc;
      }
      const imgInfo = imageInfos[idx];
      acc.push({
        ...imgInfo,
        ...x.value,
        // FIXME: How can we get rid of the cast?
      } as CanvasImage);
      return acc;
    }, [] as CanvasImage[])
  const failures: ImageFetchFailure[] = results
    .filter((x): x is PromiseRejectedResult => x.status === 'rejected')
    .map((x, idx) => {
      const info = imageInfos[idx];
      return {
        ...info,
        cause: x.reason,
      }
    });
  const ppi = ppiOverride;
  if (!ppiOverride) {
    let ppi = getPointsPerInch(canvas.service) ?? undefined;
    if (ppi && scaleFactor) {
      ppi = ppi * scaleFactor;
    }
  }
  let text;
  if (!sizeOnly) {
    try {
      text = await fetchAndParseText(canvas, undefined);
    } catch (err) {
      log.warn(`Failed to fetch text for canvas ${canvas.id}: ${err}`);
    }
  }
  return {
    canvas,
    images: canvasImages,
    imageFailures: failures,
    ppi,
    text,
    annotations: getCanvasAnnotations(canvas),
  };
}

/** Download the JSON data for a manifest, handling stuff like broken CORS implementations
 *  and Content-Negotiation for IIIFv3 */
export async function fetchManifestJson(manifestUrl: string): Promise<any> {
  try {
    const resp = await fetch(manifestUrl, {
      headers: {
        Accept: MANIFEST_ACCEPT_HEADER
      }
    });
    return await resp.json();
  } catch (err) {
    // Check if fetching failed due to CORS by downgrading the request to a
    // 'simple' request by removing the `Accept` header, which makes the
    // request CORS-unsafe due to double quotes and the colon in the URL
    const resp = await fetch(manifestUrl);
    return await resp.json();
  }
}

/** Fetch the full IIIF Image service definition from
 * its info.json endpoint. */
export async function fetchFullImageService(
  serviceRef: ImageService
): Promise<ImageService> {
  const serviceUrl = `${serviceRef['@id'] ?? serviceRef.id}/info.json`;
  const resp = await fetch(serviceUrl);
  const res = await resp.json();
  return res as ImageService;
}