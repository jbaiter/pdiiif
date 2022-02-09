import fetch from 'cross-fetch';
import minBy from 'lodash/minBy';
import { Mutex } from 'async-mutex';
import { Canvas } from 'manifesto.js';

import { OcrPage, fetchAndParseText } from './ocr';
import metrics from './metrics';
import { abort } from 'process';

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
};

/** Calculate the image size to fetch, based on user constraints and available sizes
 *  in the Image API info.json response.
 */
export function getImageSize(infoJson: any, scaleFactor = 1): SizeInfo {
  let sizeStr: string;
  const isIIIFv3 =
    (Array.isArray(infoJson['@context'])
      ? infoJson['@context'].slice(-1)[0]
      : infoJson['@context']) === 'http://iiif.io/api/image/3/context.json';
  const maxWidth = infoJson.maxWidth ?? infoJson.width;
  let requestedWidth = Math.floor(scaleFactor * maxWidth);
  const aspectRatio = infoJson.width / infoJson.height;
  const supportsScaleByWh =
    (infoJson.profile instanceof String &&
      infoJson.profile.indexOf('level2') >= 0) ||
    infoJson.profile[0].indexOf('level2') >= 0 ||
    infoJson.profile[1]?.supports?.indexOf('sizeByWh') >= 0;
  if (scaleFactor < 1 && !supportsScaleByWh) {
    // AR-compliant downscaling is not supported, find the closest available size
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    requestedWidth = minBy(
      infoJson.sizes.map((dims: any) => Math.abs(requestedWidth - dims.width))
    )!;
    sizeStr = `${requestedWidth},`;
  } else if (scaleFactor == 1) {
    sizeStr =
      isIIIFv3 || infoJson.maxWidth || infoJson.maxArea ? 'max' : 'full';
    if (infoJson.maxWidth) {
      requestedWidth = infoJson.maxWidth;
    } else if (infoJson.maxHeight) {
      requestedWidth = Math.round(aspectRatio * infoJson.maxHeight);
    } else if (infoJson.maxArea) {
      const fullArea = infoJson.width * infoJson.height;
      const scaleFactor = infoJson.maxArea / fullArea;
      requestedWidth = Math.round(scaleFactor * infoJson.width);
    } else {
      requestedWidth = infoJson.width;
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

/** Fetch the first image associated with a canvas. */
export async function fetchImage(
  canvas: Canvas,
  { scaleFactor, ppiOverride, abortSignal, sizeOnly = false }: FetchImageOptions
): Promise<ImageData | undefined> {
  if (abortSignal?.aborted) {
    console.debug('Abort signalled, aborting before initiating image data fetching.');
    return;
  }
  const img = canvas.getImages()[0].getResource();
  let imgUrl: string;
  let width: number;
  let height: number;
  let infoJson: any;
  if (img.getServices().length > 0) {
    const imgService = img.getServices()[0];
    const stopMeasuring = metrics?.imageFetchDuration.startTimer({
      iiif_host: new URL(imgService.id).host,
    });
    try {
      infoJson = await (
        await fetchRespectfully(`${imgService.id}/info.json`, { signal: abortSignal })
      ).json();
      stopMeasuring?.({
        status: 'success',
        limited: rateLimitRegistry.isLimited(imgService.id).toString(),
      });
    } catch (err) {
      stopMeasuring?.({
        status: 'error',
        limited: rateLimitRegistry.isLimited(imgService.id).toString(),
      });
      console.error(
        `Failed to fetch image info from ${imgService.id}/info.json`
      );
      throw err;
    }
    if (abortSignal?.aborted) {
      return;
    }
    const sizeInfo = getImageSize(infoJson, scaleFactor);
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
  let imgData: ArrayBuffer | undefined;
  let imgSize: number;
  const stopMeasuring = metrics?.imageFetchDuration.startTimer({
    iiif_host: new URL(imgUrl).host,
  });
  try {
    const imgResp = await fetchRespectfully(imgUrl, {
      method: 'GET',
      signal: abortSignal,
    });
    if (imgResp.status >= 400) {
      throw new Error(
        `Failed to fetch page image from ${imgUrl}, server returned status ${imgResp.status}`
      );
    }
    if (abortSignal?.aborted) {
      return;
    }
    imgSize = Number.parseInt(imgResp.headers.get('Content-Length') ?? '-1');
    imgData =
      sizeOnly && imgSize >= 0 ? undefined : await imgResp.arrayBuffer();
    if (imgSize < 0) {
      imgSize = imgData?.byteLength ?? -1;
    }
    stopMeasuring?.({
      status: 'success',
      limited: rateLimitRegistry.isLimited(imgUrl).toString(),
    });
  } catch (err) {
    stopMeasuring?.({
      status: 'error',
      limited: rateLimitRegistry.isLimited(imgUrl).toString(),
    });
    console.error(`Failed to fetch image data from ${imgUrl}: ${err}`);
    return undefined;
  }
  return {
    data: imgData,
    width,
    height,
    ppi: getPointsPerInch(infoJson, canvas, width, ppiOverride),
    numBytes: imgSize,
    text: await fetchAndParseText(canvas, undefined, scaleFactor),
  };
}
