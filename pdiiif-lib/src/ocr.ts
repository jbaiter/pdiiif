/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable complexity */
/// Utilities for parsing OCR text from hOCR, ALTO and IIIF Annotations
import {
  Annotation,
  ContentResource,
} from '@iiif/presentation-3';
import {
  AnnotationNormalized,
  CanvasNormalized,
} from '@iiif/presentation-3-normalized';
import {
  parseAltoPages,
  parseHocrPages,
  type OcrPage,
  type OcrLine,
  Dimensions,
} from 'ocr-parser';

import metrics from './metrics.js';
import { fetchRespectfully, rateLimitRegistry } from './download.js';
import {
  isExternalWebResourceWithProfile,
  ExternalWebResourceWithProfile,
  vault,
} from './iiif.js';

export type OcrPageWithMarkup = OcrPage & {
  id: string;
  markup: string;
  mimeType: string;
};

/** Helper to calculate a rough fallback image size from the line coordinates
 *
 * @param {array} lines the parsed OCR lines
 * @returns {object} the page size estimated from the line coordinates
 */
function getFallbackImageSize(lines: OcrLine[]): Dimensions {
  return {
    width: Math.max(...lines.map(({ x, width }) => x + (width ?? 0))) ?? 0,
    height: Math.max(...lines.map(({ y, height }) => y + height)) ?? 0,
  };
}

/**
 * Parse an OCR document (currently hOCR or ALTO)
 *
 * @param {string} ocrText  ALTO or hOCR markup
 * @param {object} referenceSize Reference size to scale coordinates to
 * @returns {OcrPage} the parsed OCR page
 */
export async function parseOcr(
  id: string,
  ocrText: string,
  referenceSize: Dimensions
): Promise<OcrPageWithMarkup | null> {
  let pageIter: AsyncGenerator<OcrPage>;
  const isAlto = ocrText.indexOf('<alto') >= 0;
  if (isAlto) {
    pageIter = parseAltoPages(ocrText, [referenceSize]);
  } else {
    pageIter = parseHocrPages(ocrText, [referenceSize]);
  }
  const page = (await pageIter.next()).value as OcrPage | undefined;
  if (!page) {
    return null;
  }
  return {
    ...page,
    id,
    markup: ocrText,
    mimeType: isAlto ? 'application/xml+alto' : 'text/vnd.hocr+html',
  };
}

/** Parse OCR data from IIIF annotations.
 *
 * Annotations should be pre-filtered so that they all refer to a single canvas/page.
 * Annotations should only contain a single text granularity, that is either line or word.
 *
 * @param {object} annos IIIF annotations with a plaintext body and line or word granularity
 * @param {Dimensions} imgSize Reference width and height of the rendered target image
 * @returns {OcrPage} parsed OCR boxes
 */
export function parseIiifAnnotations(
  annos: Array<Annotation>,
  imgSize: Dimensions
): OcrPage {
  throw 'Currently not supported';
}

/** Checks if a given resource points to an ALTO OCR document */
const isAlto = (resource: ExternalWebResourceWithProfile) =>
  resource.format === 'application/xml+alto' ||
  resource.profile?.startsWith('http://www.loc.gov/standards/alto/');

/** Checks if a given resource points to an hOCR document */
const isHocr = (resource: ExternalWebResourceWithProfile) =>
  resource.format === 'text/vnd.hocr+html' ||
  resource.profile ===
    'https://github.com/kba/hocr-spec/blob/master/hocr-spec.md' ||
  resource.profile?.startsWith('http://kba.cloud/hocr-spec/') ||
  resource.profile?.startsWith('http://kba.github.io/hocr-spec/');

/** Wrapper around fetch() that returns the content as text */
async function fetchOcrMarkup(url: string): Promise<string | undefined> {
  const resp = await fetchRespectfully(url);
  if (resp.status === 404) {
    return undefined;
  }
  if (resp.status != 200) {
    throw new Error(
      `Could not fetch OCR markup from ${url}, got status code ${resp.status}`
    );
  }
  return resp.text();
}

/** Fetch external annotation resource JSON */
export async function fetchAnnotationResource(url: string): Promise<any> {
  const resp = await fetchRespectfully(url);
  return resp.json();
}

/** Retrieve a supported OCR references from a Canvas' `seeAlso` or `rendering`, if present.
 *
 * 'Supported' currently means external ALTO or hOCR markup.
 */
export function getOcrReferences(
  canvas: CanvasNormalized
): ExternalWebResourceWithProfile | undefined {
  const refs = vault.get<ContentResource>(canvas.seeAlso.map((r) => r.id));
  refs.push(...vault.get<ContentResource>(canvas.rendering.map((r) => r.id)));
  return refs
    .filter(isExternalWebResourceWithProfile)
    .find((r) => isAlto(r) || isHocr(r));
}

export async function fetchAndParseText(
  canvas: CanvasNormalized,
  annotations?: AnnotationNormalized[]
): Promise<OcrPageWithMarkup | undefined> {
  // TODO: Annotations are a major PITA due to all the indirection and multiple
  //       levels of fetching of external resources that might be neccessary,
  //       save for later once text rendering is properly done.
  const ocrRefs = getOcrReferences(canvas);
  if (ocrRefs) {
    const stopMeasuring = metrics?.ocrFetchDuration.startTimer({
      ocr_host: new URL(ocrRefs.id!).host,
    });
    let markup;
    try {
      markup = await fetchOcrMarkup(ocrRefs.id!);
      stopMeasuring?.({
        status: 'success',
        limited: rateLimitRegistry.isLimited(ocrRefs.id!).toString(),
      });
      if (!markup) {
        return undefined;
      }
    } catch (err) {
      stopMeasuring?.({
        status: 'error',
        limited: rateLimitRegistry.isLimited(ocrRefs.id!).toString(),
      });
      throw err;
    }
    return (
      (await parseOcr(ocrRefs.id!, markup, {
        width: canvas.width,
        height: canvas.height,
      })) ?? undefined
    );
  }
}
