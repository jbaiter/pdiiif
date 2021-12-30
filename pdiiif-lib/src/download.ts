import fetch from 'cross-fetch';
import minBy from 'lodash/minBy';
import { Mutex } from 'async-mutex';
import { Canvas } from 'manifesto.js';

import { OcrPage, fetchAndParseText } from './ocr';
import { CancelToken } from '.';

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
    this.callbacks.forEach(cb => cb(host, true));
    return mutex;
  }

  unlimitHost(host: string): void {
    this.hostMutexes.delete(host);
    this.callbacks.forEach(cb => cb(host, false));
  }

  subscribe(cb: (host: string, limited: boolean) => void): number {
    this.callbacks.push(cb);
    return this.callbacks.length - 1;
  }

  unsubscribe(ticket: number) {
    this.callbacks.splice(ticket, 1);
  }
}

export const rateLimitRegistry = new RateLimitingRegistry();

/** A 'respectful' wrapper around `fetch` that tries to respect rate-limiting headers. */
export async function fetchRespectfully(
  url: string,
  init?: RequestInit,
  maxRetries = 5
): Promise<Response> {
  const { host } = new URL(url);
  // If the host associated with the URL is rate-limited, limit concurrency to a single
  // fetch at a time by acquiring the mutex for the host.
  let rateLimitMutex = rateLimitRegistry.getMutex(host);
  let numRetries = -1;
  let resp: Response;
  let waitMs = 0;
  // If we're fetching from a rate-limited host, wait until there's no other fetch for it
  // going on
  const release = await rateLimitMutex?.acquire();
  try {
    do {
      resp = await fetch(url, init);
      numRetries++;
      if (resp.ok || resp.status >= 500) {
        break;
      }

      const retryAfter = resp.headers.get('retry-after');
      if (retryAfter != null) {
        if (Number.isInteger(retryAfter)) {
          waitMs = Number.parseInt(retryAfter, 10) * 1000;
        } else {
          const waitUntil = Date.parse(retryAfter);
          waitMs = waitUntil - Date.now();
        }
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
          .map((header) => resp.headers.get(header))
          .filter((limit: string | null): limit is string => limit != null)
          .map((limit) => Number.parseInt(limit, 10))
          .find((limit) => limit != null);
      };
      const limit = getHeaderValue('ratelimit-limit');
      const remaining = getHeaderValue('ratelimit-remaining');
      const reset = getHeaderValue('ratelimit-reset');
      if (
        limit === undefined ||
        remaining === undefined ||
        reset === undefined
      ) {
        break;
      }
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

      // Add a 100ms buffer just to be safe and wait until the next attempt
      await new Promise((resolve) => setTimeout(resolve, waitMs + 100));
    } while (numRetries < maxRetries);
  } finally {
    if (waitMs > 0) {
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
}

/** Calculate the image size to fetch, based on user constraints and available sizes
 *  in the Image API info.json response.
 */
export function getImageSize(infoJson: any, requestedWidth?: number): SizeInfo {
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
export function getPointsPerInch(
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

/** Image data and associated information */
export type ImageData = {
  data?: ArrayBuffer;
  width: number;
  height: number;
  ppi: number;
  numBytes: number;
  text?: OcrPage;
}

/** Options for fetching image */
export type FetchImageOptions = {
  /// Maximum width of the image to fetch
  maxWidth?: number;
  /// PPI override, will be fetched from physical dimensions serivce by default
  ppiOverride?: number;
  // Optional token to use for cancelling the image fetching
  cancelToken?: CancelToken;
  /// Only obtain the size of the image, don't fetch any data
  sizeOnly?: boolean;
}

/** Fetch the first image associated with a canvas. */
export async function fetchImage(
  canvas: Canvas,
  {
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
    infoJson = await (
      await fetchRespectfully(`${imgService.id}/info.json`)
    ).json();
    if (cancelToken?.isCancellationConfirmed) {
      return;
    } else if (cancelToken?.isCancellationRequested) {
      cancelToken.confirmCancelled();
      return;
    }
    const sizeInfo = getImageSize(infoJson, maxWidth);
    const { iiifSize } = sizeInfo;
    width = sizeInfo.width;
    height = sizeInfo.height;
    imgUrl = `${imgService.id}/full/${iiifSize}/0/default.jpg`;
  } else {
    imgUrl = img.id;
    width = img.getWidth();
    height = img.getHeight();
    infoJson = { width, height };
  }
  let imgResp = await fetchRespectfully(imgUrl, {
    method: sizeOnly ? 'HEAD' : 'GET',
  });
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
    imgResp = await fetchRespectfully(imgUrl);
    imgSize = (await imgResp.arrayBuffer()).byteLength;
  }
  return {
    data: imgData,
    width,
    height,
    ppi: getPointsPerInch(infoJson, canvas, width, ppiOverride),
    numBytes: imgSize,
    text: await fetchAndParseText(canvas),
  };
}
