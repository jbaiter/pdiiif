/*
import { TextEncoder, TextDecoder } from 'util'
(global as any).TextEncoder = TextEncoder;
(global as any).TextDecoder = TextDecoder;
*/
import jsdom from 'jsdom';
import createDOMPurify, { DOMPurifyI } from 'dompurify';
import CSSColor from 'color';

import { PdfDictionary } from './common';
import { Annotation } from '../iiif';
import {
  BoxSelector,
  SelectorStyle,
  SupportedSelector,
  SvgSelector,
} from '@iiif/vault-helpers/annotation-targets';
import { PointSelector } from '@iiif/presentation-3';
import Color from 'color';

const ALLOWED_CSS_RULES = [
  'text-align',
  'vertical-align',
  'font-size',
  'font-weight',
  'font-style',
  'font-family',
  'font',
  'color',
  'text-decoration',
  'font-stretch',
];
const CSS_PAT = /\s*(?<attrib>[^:]+)\s*:\s*(?<val>[^;]+)(?:;|$)/gm;
const RGB_PAT = /rgb\((?<r>\d+)\s*,\s*(?<g>\d+)\s*,\s*(?<b>\d+)\)/;
const CSS_LENGTH_PAT = /(?<val>\d+(?:\.\d+)?)\s*(?<unit>[[a-z%]+)?/;

function sanitizeCssForPdf(styleAttrib: string): string {
  let parts: RegExpExecArray | null;
  const out: Array<string> = [];
  while ((parts = CSS_PAT.exec(styleAttrib)) !== null) {
    const [, attrib, value] = parts;
    if (!ALLOWED_CSS_RULES.includes(attrib)) {
      continue;
    }
    out.push(`${attrib}: ${value}`);
  }
  return out.join('; ');
}

let DOMPurify: DOMPurifyI;
let dummyDoc: Document;
if (typeof window === 'undefined') {
  const window = new jsdom.JSDOM('').window as unknown;
  dummyDoc = (window as Window).document;
  DOMPurify = createDOMPurify(window as Window);
} else {
  DOMPurify = createDOMPurify(window);
  dummyDoc = window.document;
}
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName !== 'style') {
    return;
  }
  data.attrValue = sanitizeCssForPdf(data.attrValue);
});

function htmlToPdfRichText(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'b', 'i', 'span'],
    ALLOWED_ATTR: ['style'],
  });
}

function htmlToPlainText(html: string): string {
  const elem = dummyDoc.createElement('div');
  elem.innerHTML = html;
  return elem.textContent ?? elem.innerText;
}

function toPdfRect(
  selector: BoxSelector | SvgSelector,
  pageHeight: number,
  unitScale: number
): PdfDictionary | null {
  if (!selector.spatial) {
    return null;
  }
  const lly = pageHeight - selector.spatial.y;
  const ury = lly - selector.spatial.height;
  return {
    Subtype: '/Square',
    Rect: [
      selector.spatial.x * unitScale,
      lly * unitScale,
      (selector.spatial.x + selector.spatial.width) * unitScale,
      ury * unitScale,
    ],
  };
}

function cssColorToRgb(cssColor: string): [number, number, number] | null {
  // NodeJS: Use color-convert
  if (typeof Color !== 'undefined') {
    return Color(cssColor).rgb().array() as [number, number, number];
  }
  // Codepath for browser: Use the DOM, it knows how to parse colors (-:
  const dummyElem = window.document.createElement('div');
  dummyElem.style.background = cssColor;
  dummyElem.style.display = 'none';
  // Need to add the element to the actual DOM to have the style computed...
  document.appendChild(dummyElem);
  const rgb = window.getComputedStyle(dummyElem).backgroundColor;
  document.removeChild(dummyElem);
  const match = RGB_PAT.exec(rgb);
  if (!match) {
    console.warn(`Failed to convert CSS color to RGB: ${cssColor}`);
    return null;
  }
  return ['r', 'g', 'b'].map((col) =>
    parseInt(match.groups?.[col] ?? '0', 10)
  ) as [number, number, number];
}

function cssLengthToPdfUserspace(
  cssLength: string,
  unitScale: number,
  referenceDimensionPx?: number
): number | null {
  const match = CSS_LENGTH_PAT.exec(cssLength);
  if (!match || !match.groups) {
    return null;
  }
  const val = parseFloat(match.groups.val);
  const unit = match.groups.unit;
  if (!unit) {
    return val * unitScale;
  }
  switch (unit) {
    case '%':
      if (!referenceDimensionPx) {
        return null;
      }
      return (val / 100) * referenceDimensionPx * unitScale;
    case 'px':
      return unitScale * val;
    default:
      console.warn(`Unsupported CSS length unit: ${unit}`);
      return null;
  }
}

function selectorStyleToPdf(
  style: SelectorStyle,
  unitScale: number
): PdfDictionary {
  const pdfStyle: PdfDictionary = {};
  if (style.stroke || style.strokeDasharray || style.strokeWidth) {
    pdfStyle.BS = {
      Type: '/Border',
      W: style.strokeWidth ?? 1,
      S: style.strokeDasharray ? '/D' : '/S',
    };
    if (style.strokeDasharray) {
      pdfStyle.BS.D = style.strokeDasharray;
    }
  }
  if (style.fill) {
    const rgb = cssColorToRgb(style.fill);
    if (rgb) {
      pdfStyle.IC = rgb.map((c) => c / 255);
    }
  }
  // TODO: Check if fill-opacity is desired and use an Apperance Stream instead of IC
  if (style.strokeWidth) {
    const width = cssLengthToPdfUserspace(style.strokeWidth, unitScale);
    pdfStyle.BS = {
      Type: '/Border',
      W: width,
    };
  }
  return pdfStyle;
}

function selectorToPdf(
  selector: SupportedSelector,
  unitScale: number,
  pageHeight: number
): PdfDictionary {
  const styleDict = selector.style
    ? selectorStyleToPdf(selector.style, unitScale)
    : {};
  switch (selector.type) {
    case 'BoxSelector':
      return {
        Subtype: '/Square',
        ...toPdfRect(selector as BoxSelector, pageHeight, unitScale),
        ...styleDict,
      };
    case 'PointSelector': {
      // TODO: Use a /Stamp with a custom icon (flag?)
      //       This is a bit complicated since we need to povide
      //       an /AP dictionary with a custom /Form that
      //       renders our icon. Luckily, this can be reused, so
      //       we store it once and just reference it in all point-type
      //       annotations.
      const point = selector as PointSelector;
      if (!point.x || !point.y) {
        throw `Only PointSelectors with both x and y coordinates are supported!`;
      }
      return {
        Subtype: '/Circle',
        BS: {
          Type: '/Border',
          W: 2,
          S: '/S',
        },
        IC: [1.0, 1.0, 1.0],
        Rect: [
          point.x * unitScale - 0.5,
          point.y * unitScale - 0.5,
          point.x * unitScale + 1.0,
          point.y * unitScale + 1.0,
        ],
      };
    }
    case 'SvgSelector': {
      const svgSel = selector as SvgSelector;
      switch (svgSel.svgShape) {
        case 'rect':
          return {
            Subtype: '/Square',
            ...toPdfRect(svgSel, pageHeight, unitScale),
            ...styleDict,
          };
        case 'circle':
        case 'ellipse':
          return {
            Subtype: '/Circle',
            Rect: toPdfRect(svgSel, pageHeight, unitScale),
            ...styleDict,
          };
        case 'polyline':
        case 'polygon':
          return {
            Subtype: svgSel.svgShape === 'polyline' ? '/PolyLine' : '/Polygon',
            Vertices:
              svgSel.points?.flatMap(([x, y]) => [
                x * unitScale,
                (pageHeight - y) * unitScale,
              ]) ?? [],
            ...styleDict,
          };
        case 'path':
          return {
            Subtype: '/Ink',
            InkList:
              svgSel.points?.flatMap(([x, y]) => [
                x * unitScale,
                (pageHeight - y) * unitScale,
              ]) ?? [],
            ...styleDict,
          };
        default:
          throw new Error('not implemented yet');
      }
    }
    default:
      throw `${selector.type} selector is currently not supported`;
  }
}

export function exportPdfAnnotation(
  anno: Annotation,
  unitScale: number,
  pageHeight: number
): Array<PdfDictionary> {
  const annoDict: PdfDictionary = {
    Type: '/Annot',
    NM: `(${anno.id})`,
    Contents: `(${htmlToPlainText(anno.markup)})`,
    F: 4,
    C: [1, 0, 0], // Red title bar
    CA: 1, // Constant opacity of 1
    Border: [0, 0, 5],
    //RC: `(${htmlToPdfRichText(anno.markup)})`,
  };
  if (anno.author) {
    annoDict.T = `(${anno.author})`;
  }
  if (anno.lastModified) {
    annoDict.M = anno.lastModified;
  }
  if (anno.target.selector) {
    return [
      {
        ...annoDict,
        ...selectorToPdf(anno.target.selector, unitScale, pageHeight),
      },
    ] as PdfDictionary[];
  } else if (anno.target.selectors && anno.target.selectors.length > 0) {
    return anno.target.selectors.map((s) => ({
      ...annoDict,
      ...selectorToPdf(s, unitScale, pageHeight),
    })) as PdfDictionary[];
  }
  return [];
}
