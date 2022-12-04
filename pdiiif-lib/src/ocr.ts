/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable complexity */
/// Utilities for parsing OCR text from hOCR, ALTO and IIIF Annotations
import { max } from 'lodash-es';
import fetch from 'cross-fetch';
import jsdom from 'jsdom';
import {
  Annotation,
  AnnotationNormalized,
  CanvasNormalized,
  ContentResource,
} from '@iiif/presentation-3';

import metrics from './metrics.js';
import { fetchRespectfully, rateLimitRegistry } from './download.js';
import log from './log.js';
import {
  isExternalWebResourceWithProfile,
  ExternalWebResourceWithProfile,
  vault,
} from './iiif.js';

let parser: DOMParser;
let TextType: typeof Text;
if (typeof window === 'undefined') {
  const nodeDom = new jsdom.JSDOM();
  parser = new nodeDom.window.DOMParser();
  TextType = nodeDom.window.Text;
} else {
  parser = new DOMParser();
  TextType = Text;
}

interface HocrAttribs {
  [key: string]: string | number[];
}

export interface OcrSpan {
  x: number;
  y: number;
  height: number;
  width?: number;
  text?: string;
  style?: string;
  isExtra?: boolean;
  spans: OcrSpan[];
}

export interface OcrPage {
  id: string;
  width: number;
  height: number;
  blocks?: Array<{ paragraphs: Array<{ lines: Array<OcrSpan> }> }>;
  paragraphs?: Array<{ lines: Array<OcrSpan> }>;
  lines?: Array<OcrSpan>;
  markup?: string;
  mimeType: string;
}

export interface Dimensions {
  width: number;
  height: number;
}

/** Parse hOCR attributes from a node's title attribute
 *
 * @param {string} titleAttrib The content of an hOCR node's `@title` attribute
 * @returns {object} the parsed hOCR attributes
 */
function parseHocrAttribs(titleAttrib: string): HocrAttribs {
  const vals = titleAttrib.split(';').map((x) => x.trim());
  return vals.reduce((acc, val) => {
    const key = val.split(' ')[0];
    // Special handling for bounding boxes, convert them to a number[4]
    if (key === 'bbox') {
      acc[key] = val
        .split(' ')
        .slice(1, 5)
        .map((x) => Number.parseInt(x, 10));
    } else {
      acc[key] = val.split(' ').slice(1, 5).join(' ');
    }
    return acc;
  }, {} as HocrAttribs);
}

/** Parse an hOCR node
 *
 * @param {HTMLElement} node DOM node from hOCR parse, either a ocrx_word or ocr_line
 * @param {boolean} endOfLine whether the node is the end of a line
 * @param {number} scaleFactor how much to scale the coordinates by
 * @return {array} the parsed OCR spans (length == 2 only when line ends on text content without coordinates)
 */
function parseHocrNode(
  node: HTMLElement,
  endOfLine = false,
  scaleFactor = 1
): OcrSpan[] {
  const [ulx, uly, lrx, lry] = (
    parseHocrAttribs(node.title).bbox as number[]
  ).map((dim) => dim * scaleFactor);
  let style = node.getAttribute('style');
  if (style) {
    style = style.replace(/font-size:.+;/, '');
  }
  const spans: OcrSpan[] = [
    {
      height: lry - uly,
      style: style ?? undefined,
      text: node.textContent ?? undefined,
      width: lrx - ulx,
      x: ulx,
      y: uly,
      isExtra: false,
      spans: [],
    },
  ];

  // Add an extra space span if the following text node contains something
  if (node.nextSibling instanceof TextType) {
    let extraText = node.nextSibling.wholeText.replace(/\s+/, ' ');
    if (endOfLine) {
      // We don't need trailing whitespace
      extraText = extraText.trimEnd();
    }
    if (extraText.length > 0) {
      spans.push({
        height: lry - uly,
        text: extraText,
        x: lrx,
        y: uly,
        // NOTE: This span has no width initially, will be set when we encounter
        //       the next word. (extra spans always fill the area between two words)
        isExtra: true,
        spans: [],
      });
    }
  }
  const lastSpan = spans.slice(-1)[0];
  if (endOfLine && lastSpan.text?.slice(-1) !== '\u00AD') {
    // Add newline if the line does not end on a hyphenation (a soft hyphen)
    lastSpan.text += '\n';
  }
  return spans;
}

function parseHocrLineNode(lineNode: Element, scaleFactor: number): OcrSpan {
  const wordNodes = lineNode.querySelectorAll('span.ocrx_word');
  if (wordNodes.length === 0) {
    return parseHocrNode(lineNode as HTMLDivElement, true, scaleFactor)[0];
  } else {
    const line = parseHocrNode(
      lineNode as HTMLDivElement,
      true,
      scaleFactor
    )[0];
    const spans = [];
    // eslint-disable-next-line no-unused-vars
    for (const [i, wordNode] of wordNodes.entries()) {
      const textSpans = parseHocrNode(
        wordNode as HTMLSpanElement,
        i === wordNodes.length - 1,
        scaleFactor
      );

      // Calculate width of previous extra span
      const previousExtraSpan = spans.slice(-1).filter((s) => s.isExtra)?.[0];
      if (previousExtraSpan) {
        previousExtraSpan.width = textSpans[0].x - previousExtraSpan.x;
      }

      spans.push(...textSpans);
    }

    // Update with of extra span at end of line
    const endExtraSpan = spans.slice(-1).filter((s) => s.isExtra)?.[0];
    if (endExtraSpan) {
      endExtraSpan.width = line.x + (line.width ?? 0) - endExtraSpan.x;
    }

    line.spans = spans;
    line.text = spans
      .map((w) => w.text)
      .join('')
      .trim();
    return line;
  }
}

/** Parse an hOCR document
 *
 * @param {string} hocrText the raw hOCR markup
 * @param {object} referenceSize the size of the corresponding page image
 * @returns {object} the parsed OCR page
 */
export function parseHocr(
  id: string,
  hocrText: string,
  referenceSize: Dimensions
): OcrPage | null {
  const doc = parser.parseFromString(hocrText, 'text/html');
  const pageNode = doc.querySelector('div.ocr_page');
  if (pageNode === null) {
    return null;
  }
  const pageSize = parseHocrAttribs((pageNode as HTMLDivElement).title)
    .bbox as [number, number, number, number];
  let scaleFactor = 1;
  if (
    pageSize[2] !== referenceSize.width ||
    pageSize[3] !== referenceSize.height
  ) {
    const scaleFactorX = referenceSize.width / pageSize[2];
    const scaleFactorY = referenceSize.height / pageSize[3];
    const scaledWidth = Math.round(scaleFactorY * pageSize[2]);
    const scaledHeight = Math.round(scaleFactorX * pageSize[3]);
    if (
      scaledWidth !== referenceSize.width ||
      scaledHeight !== referenceSize.height
    ) {
      log.debug(
        `Differing scale factors for x and y axis: x=${scaleFactorX}, y=${scaleFactorY}`
      );
    }
    scaleFactor = scaleFactorX;
  }
  let blocks:
    | Array<{ paragraphs: Array<{ lines: Array<OcrSpan> }> }>
    | undefined = [];
  for (const blockNode of pageNode.querySelectorAll(
    'div.ocr_carea, div.ocrx_block'
  )) {
    const block: { paragraphs: Array<{ lines: Array<OcrSpan> }> } = {
      paragraphs: [],
    };
    for (const paragraphNode of blockNode.querySelectorAll('p.ocr_par')) {
      const paragraph: { lines: Array<OcrSpan> } = { lines: [] };
      for (const lineNode of paragraphNode.querySelectorAll(
        'span.ocr_line, span.ocrx_line'
      )) {
        paragraph.lines.push(
          parseHocrLineNode(lineNode as HTMLElement, scaleFactor)
        );
      }
      block.paragraphs.push(paragraph);
    }
    blocks.push(block);
  }
  if (blocks.length === 0) {
    blocks = undefined;
  }
  let paragraphs: Array<{ lines: Array<OcrSpan> }> | undefined = [];
  if (!blocks) {
    for (const paragraphNode of pageNode.querySelectorAll('p.ocr_par')) {
      const paragraph: { lines: Array<OcrSpan> } = { lines: [] };
      for (const lineNode of paragraphNode.querySelectorAll(
        'span.ocr_line, span.ocrx_line'
      )) {
        paragraph.lines.push(
          parseHocrLineNode(lineNode as HTMLElement, scaleFactor)
        );
      }
      paragraphs.push(paragraph);
    }
  }
  if (paragraphs.length === 0) {
    paragraphs = undefined;
  }

  let lines: Array<OcrSpan> | undefined = [];
  if (!blocks && !paragraphs) {
    for (const lineNode of pageNode.querySelectorAll(
      'span.ocr_line, span.ocrx_line'
    )) {
      lines.push(parseHocrLineNode(lineNode, scaleFactor));
    }
  }
  if (lines.length === 0) {
    lines = undefined;
  }
  return {
    id,
    height: Math.round(scaleFactor * pageSize[3]),
    blocks,
    paragraphs,
    lines,
    width: Math.round(scaleFactor * pageSize[2]),
    markup: hocrText,
    mimeType: 'text/vnd.hocr+html',
  };
}

/** Create CSS directives from an ALTO TextStyle node
 *
 * @param {Element} styleNode The ALTO node with style information
 * @returns {string} the corresponding CSS style string
 */
function altoStyleNodeToCSS(styleNode: Element): string {
  // NOTE: We don't map super/subscript, since it would change the font size
  const fontStyleMap: { [key: string]: string } = {
    bold: 'font-weight: bold',
    italics: 'font-style: italic',
    smallcaps: 'font-variant: small-caps',
    underline: 'text-decoration: underline',
  };
  const styles = [];
  if (styleNode.hasAttribute('FONTFAMILY')) {
    styles.push(`font-family: ${styleNode.getAttribute('FONTFAMILY')}`);
  }
  if (styleNode.hasAttribute('FONTTYPE')) {
    styles.push(`font-type: ${styleNode.getAttribute('FONTTYPE')}`);
  }
  if (styleNode.hasAttribute('FONTCOLOR')) {
    styles.push(`color: #${styleNode.getAttribute('FONTCOLOR')}`);
  }
  if (styleNode.hasAttribute('FONTSTYLE')) {
    const altoStyle = styleNode.getAttribute('FONTSTYLE');
    if (altoStyle !== null && altoStyle in fontStyleMap) {
      styles.push(fontStyleMap[altoStyle]);
    }
  }
  return styles.join(';');
}

/**
 * Parse an ALTO document.
 *
 * Needs access to the (unscaled) target image size since it ALTO uses 10ths of
 * millimeters for units by default and we need pixels.
 *
 * @param {string} altoText Raw text with ALTO markup
 * @param {object} imgSize Size of the target image
 * @returns {object} the parsed OCR page
 */
export function parseAlto(
  id: string,
  altoText: string,
  imgSize: Dimensions
): OcrPage {
  const doc = parser.parseFromString(altoText, 'text/xml');
  // We assume ALTO is set as the default namespace
  /** Namespace resolver that forrces the ALTO namespace */
  const measurementUnit = doc.querySelector(
    'alto > Description > MeasurementUnit'
  )?.textContent;
  const pageElem = doc.querySelector(
    'alto > Layout > Page, alto > Layout > Page > PrintSpace'
  ) as Element;
  let pageWidth = Number.parseInt(pageElem.getAttribute('WIDTH') ?? '0', 10);
  let pageHeight = Number.parseInt(pageElem.getAttribute('HEIGHT') ?? '0', 10);
  let scaleFactorX = 1.0;
  let scaleFactorY = 1.0;

  if (measurementUnit !== 'pixel' || pageWidth !== imgSize.width) {
    scaleFactorX = imgSize.width / pageWidth;
    scaleFactorY = imgSize.height / pageHeight;
    pageWidth *= scaleFactorX;
    pageHeight *= scaleFactorY;
  }

  const styles: { [id: string]: string } = {};
  const styleElems = doc.querySelectorAll('alto > Styles > TextStyle');
  for (const styleNode of styleElems) {
    const styleId = styleNode.getAttribute('ID');
    if (styleId !== null) {
      styles[styleId] = altoStyleNodeToCSS(styleNode);
    }
  }

  const hasSpaces = doc.querySelector('SP') !== null;
  const paragraphs: Array<{ lines: OcrSpan[] }> = [];
  let lineEndsHyphenated = false;
  for (const blockNode of doc.querySelectorAll('TextBlock')) {
    const block: { lines: OcrSpan[] } = { lines: [] };
    for (const lineNode of blockNode.querySelectorAll('TextLine')) {
      const line: OcrSpan = {
        height:
          Number.parseInt(lineNode.getAttribute('HEIGHT') ?? '0', 10) *
          scaleFactorY,
        text: '',
        width:
          Number.parseInt(lineNode.getAttribute('WIDTH') ?? '0', 10) *
          scaleFactorX,
        spans: [],
        x:
          Number.parseInt(lineNode.getAttribute('HPOS') ?? '0', 10) *
          scaleFactorX,
        y:
          Number.parseInt(lineNode.getAttribute('VPOS') ?? '0', 10) *
          scaleFactorY,
      };
      const textNodes = lineNode.querySelectorAll('String, SP, HYP');
      for (const [textIdx, textNode] of textNodes.entries()) {
        const endOfLine = textIdx === textNodes.length - 1;
        const styleRefs = textNode.getAttribute('STYLEREFS');
        let style = null;
        if (styleRefs !== null) {
          style = styleRefs
            .split(' ')
            .map((refId) => styles[refId])
            .filter((s) => s !== undefined)
            .join('');
        }

        const width =
          Number.parseInt(textNode.getAttribute('WIDTH') ?? '0', 10) *
          scaleFactorX;
        let height =
          Number.parseInt(textNode.getAttribute('HEIGHT') ?? '0', 10) *
          scaleFactorY;
        if (Number.isNaN(height)) {
          height = line.height;
        }
        const x =
          Number.parseInt(textNode.getAttribute('HPOS') ?? '0', 10) *
          scaleFactorX;
        let y =
          Number.parseInt(textNode.getAttribute('VPOS') ?? '0', 10) *
          scaleFactorY;
        if (Number.isNaN(y)) {
          y = line.y;
        }

        if (textNode.tagName === 'String' || textNode.tagName === 'HYP') {
          const text = textNode.getAttribute('CONTENT');

          // Update the width of a preceding extra space span to fill the area
          // between the previous word and this one.
          const previousExtraSpan = line.spans
            .slice(-1)
            .filter((s) => s.isExtra)?.[0];
          if (previousExtraSpan) {
            previousExtraSpan.width = x - previousExtraSpan.x;
          }

          line.spans.push({
            isExtra: false,
            x,
            y,
            width,
            height,
            text: text ?? undefined,
            style: style ?? undefined,
            spans: [],
          });

          // Add extra space span if ALTO does not encode spaces itself
          if (!hasSpaces && !endOfLine) {
            line.spans.push({
              isExtra: true,
              x: x + width,
              y,
              height,
              text: ' ',
              spans: [],
              // NOTE: Does not have width initially, will be set when we encounter
              //       the next proper word span
            });
          }
          lineEndsHyphenated = textNode.tagName === 'HYP';
        } else if (textNode.tagName === 'SP') {
          line.spans.push({
            isExtra: false,
            x,
            y,
            width,
            height,
            text: ' ',
            spans: [],
          });
        }
      }
      if (line.spans.length === 0) {
        continue;
      }
      if (!lineEndsHyphenated) {
        line.spans.slice(-1)[0].text += '\n';
      }
      lineEndsHyphenated = false;
      line.text = line.spans.map(({ text }) => text).join('');
      block.lines.push(line);
    }
    paragraphs.push(block);
  }
  return {
    id,
    height: pageHeight,
    paragraphs,
    width: pageWidth,
    markup: altoText,
    mimeType: 'application/xml+alto',
  };
}

/** Helper to calculate a rough fallback image size from the line coordinates
 *
 * @param {array} lines the parsed OCR lines
 * @returns {object} the page size estimated from the line coordinates
 */
function getFallbackImageSize(lines: OcrSpan[]): Dimensions {
  return {
    width: max(lines.map(({ x, width }) => x + (width ?? 0))) ?? 0,
    height: max(lines.map(({ y, height }) => y + height)) ?? 0,
  };
}

/**
 * Parse an OCR document (currently hOCR or ALTO)
 *
 * @param {string} ocrText  ALTO or hOCR markup
 * @param {object} referenceSize Reference size to scale coordinates to
 * @returns {OcrPage} the parsed OCR page
 */
export function parseOcr(
  id: string,
  ocrText: string,
  referenceSize: Dimensions
): OcrPage | null {
  let parse: OcrPage | null;
  if (ocrText.indexOf('<alto') >= 0) {
    parse = parseAlto(id, ocrText, referenceSize);
  } else {
    parse = parseHocr(id, ocrText, referenceSize);
  }
  if (parse === null) {
    return null;
  }
  if (!parse.width || !parse.height) {
    let lines = parse.lines;
    if (!lines) {
      lines = parse.paragraphs?.flatMap((p) => p.lines);
    }
    if (!lines) {
      lines = parse.blocks
        ?.flatMap((b) => b.paragraphs)
        ?.flatMap((p) => p.lines);
    }
    parse = { ...parse, ...getFallbackImageSize(lines || []) };
  }
  return parse;
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
  /*
  const fragmentPat = /.+#xywh=(\d+),(\d+),(\d+),(\d+)/g;

  // TODO: Handle Europeana-style v2 annotations, they are currently not
  //       being converted by @iiif/parser
  // TODO: Handle word-level annotations
  // See if we can tell from the annotations themselves if it targets a line
  const lineAnnos = annos.filter(
    (anno: any) =>
      anno.textGranularity === 'line' || // IIIF Text Granularity
      anno.dcType === 'Line' // Europeana
  );
  const targetAnnos = lineAnnos.length > 0 ? lineAnnos : annos;
  const boxes = targetAnnos.map((anno: any) => {
    let text;
    if (anno.resource) {
      text = anno.resource.chars ?? anno.resource.value;
    } else {
      text = anno.body.value;
    }
    let target = anno.target || anno.on;
    target = Array.isArray(target) ? target[0] : target;
    const [x, y, width, height] = target
      .matchAll(fragmentPat)
      .next()
      .value.slice(1, 5);
    return {
      height: parseInt(height, 10),
      text,
      width: parseInt(width, 10),
      x: parseInt(x, 10),
      y: parseInt(y, 10),
    };
  });

  return {
    ...(imgSize ?? getFallbackImageSize(boxes)),
    lines: boxes,
  };
  */
}

/** Check if an annotation has external resources that need to be loaded */
/*
function hasExternalResource(anno: Annotation): boolean {
  return (
    anno.getResource()?.getProperty('chars') === undefined &&
    anno.getBody()?.[0]?.getProperty('value') === undefined &&
    Object.keys(anno.getResource() ?? {}).length === 1 &&
    anno.getResource()?.id !== undefined
  );
}
*/

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
  const resp = await fetch(url);
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

export function getTextSeeAlso(
  canvas: CanvasNormalized
): ExternalWebResourceWithProfile | undefined {
  const seeAlsos = vault.get<ContentResource>(canvas.seeAlso);
  return seeAlsos
    .filter(isExternalWebResourceWithProfile)
    .find((r) => isAlto(r) || isHocr(r));
}

export async function fetchAndParseText(
  canvas: CanvasNormalized,
  annotations?: AnnotationNormalized[]
): Promise<OcrPage | undefined> {
  // TODO: Annotations are a major PITA due to all the indirection and multiple
  //       levels of fetching of external resources that might be neccessary,
  //       save for later once text rendering is properly done.
  const seeAlso = getTextSeeAlso(canvas);
  if (seeAlso) {
    const stopMeasuring = metrics?.ocrFetchDuration.startTimer({
      ocr_host: new URL(seeAlso.id!).host,
    });
    let markup;
    try {
      markup = await fetchOcrMarkup(seeAlso.id!);
      stopMeasuring?.({
        status: 'success',
        limited: rateLimitRegistry.isLimited(seeAlso.id!).toString(),
      });
      if (!markup) {
        return undefined;
      }
    } catch (err) {
      stopMeasuring?.({
        status: 'error',
        limited: rateLimitRegistry.isLimited(seeAlso.id!).toString(),
      });
      throw err;
    }
    return (
      parseOcr(seeAlso.id!, markup, {
        width: canvas.width,
        height: canvas.height,
      }) ?? undefined
    );
  }
}
