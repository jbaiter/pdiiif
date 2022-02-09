/* eslint-disable no-new-wrappers */
/* eslint-disable @typescript-eslint/no-non-null-assertion */

/// PDF generation code
import flatten from 'lodash/flatten';
import range from 'lodash/range';
import pad from 'lodash/padStart';
import dedent from 'dedent-js';

import {
  Metadata,
  PdfObject,
  PdfDictionary,
  makeRef,
  PdfArray,
  PdfRef,
  serialize,
  PdfValue,
  toUTF16BE,
} from './common';
import { TocItem, textEncoder, randomData, tryDeflateStream } from './util';
import { ArrayReader, Writer } from '../io';
import PdfImage from './image';
import { sRGBIEC1966_21 as srgbColorspace } from '../res/srgbColorspace';
import { PdfParser } from './parser';
import { OcrPage } from '../ocr';
import pdiiifVersion from '../version';
import log from '../log';

const PRODUCER = `pdiiif v${pdiiifVersion}`;
/// If the font is 10 pts, nominal character width is 5 pts
const CHAR_WIDTH = 2;
/// Taken from tesseract@2d6f38eebf9a14d9fbe65d785f0d7bd898ff46cb, tessdata/pdf.ttf
const FONTDATA = new Uint8Array([
  0, 1, 0, 0, 0, 10, 0, 128, 0, 3, 0, 32, 79, 83, 47, 50, 86, 222, 200, 148, 0,
  0, 1, 40, 0, 0, 0, 96, 99, 109, 97, 112, 0, 10, 0, 52, 0, 0, 1, 144, 0, 0, 0,
  30, 103, 108, 121, 102, 21, 34, 65, 36, 0, 0, 1, 184, 0, 0, 0, 24, 104, 101,
  97, 100, 11, 120, 241, 101, 0, 0, 0, 172, 0, 0, 0, 54, 104, 104, 101, 97, 12,
  2, 4, 2, 0, 0, 0, 228, 0, 0, 0, 36, 104, 109, 116, 120, 4, 0, 0, 0, 0, 0, 1,
  136, 0, 0, 0, 8, 108, 111, 99, 97, 0, 12, 0, 0, 0, 0, 1, 176, 0, 0, 0, 6, 109,
  97, 120, 112, 0, 4, 0, 5, 0, 0, 1, 8, 0, 0, 0, 32, 110, 97, 109, 101, 242,
  235, 22, 218, 0, 0, 1, 208, 0, 0, 0, 75, 112, 111, 115, 116, 0, 1, 0, 1, 0, 0,
  2, 28, 0, 0, 0, 32, 0, 1, 0, 0, 0, 1, 0, 0, 176, 148, 113, 16, 95, 15, 60,
  245, 4, 7, 8, 0, 0, 0, 0, 0, 207, 154, 252, 110, 0, 0, 0, 0, 212, 195, 167,
  242, 0, 0, 0, 0, 4, 0, 8, 0, 0, 0, 0, 16, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0,
  8, 0, 255, 255, 0, 0, 4, 0, 0, 0, 0, 0, 4, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 2, 0, 4, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 1, 144, 0, 5, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 1, 0, 1, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 71, 79, 79, 71, 0,
  64, 0, 0, 0, 0, 0, 1, 255, 255, 0, 0, 0, 1, 0, 1, 128, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0,
  0, 0, 20, 0, 3, 0, 0, 0, 0, 0, 20, 0, 6, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 12, 0, 0, 0, 1, 0, 0, 0, 0, 4, 0, 8, 0, 0, 3, 0, 0, 49, 33, 17, 33,
  4, 0, 252, 0, 8, 0, 0, 0, 0, 3, 0, 42, 0, 0, 0, 3, 0, 0, 0, 5, 0, 22, 0, 0, 0,
  1, 0, 0, 0, 0, 0, 5, 0, 11, 0, 22, 0, 3, 0, 1, 4, 9, 0, 5, 0, 22, 0, 0, 0, 86,
  0, 101, 0, 114, 0, 115, 0, 105, 0, 111, 0, 110, 0, 32, 0, 49, 0, 46, 0, 48,
  86, 101, 114, 115, 105, 111, 110, 32, 49, 46, 48, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

export default class PDFGenerator {
  _offset = 0;
  _objects: Array<PdfObject> = [];
  // Page, Contents and Image objects
  _objectsPerPage = 3;
  _nextObjNo = 1;
  _objRefs: Record<string, PdfRef> = {};
  _offsets: number[] = [];
  _writer: Writer | undefined;
  _pagesStarted = false;
  _numCanvases: number;
  _pageLabels?: string[];
  _numCoverPages = 0;
  _outline: TocItem[] = [];
  _hasText = false;

  constructor(
    writer: Writer,
    metadata: Metadata,
    numCanvases: number,
    pageLabels?: string[],
    outline: TocItem[] = [],
    hasText = false
  ) {
    this._writer = writer;
    this._numCanvases = numCanvases;
    this._pageLabels = pageLabels;
    this._outline = outline;
    this._hasText = hasText;

    const pdfMetadata: PdfDictionary = {
      ...Object.entries(metadata)
        .filter((k, v) => v !== undefined)
        .reduce((prev, [k, v]) => {
          prev[k] = `(${v})`;
          return prev;
        }, {} as PdfDictionary),
      Producer: `(${PRODUCER})`,
    };
    this._addObject(pdfMetadata, 'Info');
  }

  async setup(): Promise<void> {
    const catalog: PdfDictionary = {
      Type: '/Catalog',
    };
    this._addObject(catalog, 'Catalog');

    const pagesObj = this._addObject(
      {
        Type: '/Pages',
        Count: this._numCanvases,
      },
      'Pages'
    );
    catalog.Pages = makeRef(pagesObj);

    if (this._outline.length > 0) {
      catalog.PageMode = 'UseOutlines';
      const outlines: PdfDictionary = {
        Type: '/Outlines',
        Count: 0,
      };
      const outlinesObj = this._addObject(outlines);
      catalog.Outlines = makeRef(outlinesObj);
      let prev: PdfObject | undefined;
      for (const [idx, itm] of this._outline.entries()) {
        const [childObj, numKids] = this._addOutline(itm, outlinesObj, prev);
        (outlines.Count as number) += 1 + numKids;
        if (idx === 0) {
          outlines.First = makeRef(childObj);
        } else if (idx === this._outline.length - 1) {
          outlines.Last = makeRef(childObj);
        }
        prev = childObj;
      }
    }
    if (this._hasText) {
      await this._setupHiddenTextFont();
    }

    // Add output color space for PDF/A compliance
    // FIXME: For some reason VeraPDF thinks our color space is invalid,
    //        since we don't seem to match this rule:
    //        (N != null &&
    //          ((N == 1 && colorSpace == "GRAY")
    //           || (N == 3 && (colorSpace == "RGB " || colorSpace == "Lab "))
    //           || (N == 4 && colorSpace == "CMYK")))
    //        But N == 3 and the ICC's colorSpace value is RGB, as confirmed with
    //        Argyll's iccdump tool, so I don't know what the problem is ¯\_(ツ)_/¯
    const comp = await tryDeflateStream(srgbColorspace);
    const colorSpace = this._addObject(
      {
        ...comp.dict,
        N: 3,
      },
      undefined,
      comp.stream
    );
    catalog.OutputIntents = [
      {
        Type: '/OutputIntent',
        S: '/GTS_PDFA1',
        DestOutputProfile: makeRef(colorSpace),
        OutputConditionIdentifier: '(sRGB IEC61966-2.1)',
        Info: '(sRGB IEC61966-2.1)',
      },
    ];
  }

  async _setupHiddenTextFont(): Promise<void> {
    const typeZeroFont = this._addObject(
      {
        Type: '/Font',
        Subtype: '/Type0',
        BaseFont: '/GlyphLessFont',
        Encoding: '/Identity-H',
      },
      'Type0Font'
    );

    const typeTwoFont = this._addObject({
      type: '/Font',
      Subtype: '/CIDFontType2',
      BaseFont: '/GlyphLessFont',
      DW: 1000 / CHAR_WIDTH,
      CIDSystemInfo: {
        Ordering: '(Identity)',
        Registry: '(Adobe)',
        Supplement: 0,
      },
    });
    (typeZeroFont.data as PdfDictionary).DescendantFonts = [
      makeRef(typeTwoFont),
    ];

    const cidtoGidMapData = new Uint8Array(128 * 1024);
    for (let i = 0; i < cidtoGidMapData.length; i++) {
      cidtoGidMapData[i] = i % 2 ? 1 : 0;
    }
    const comp = await tryDeflateStream(cidtoGidMapData);
    const cidToGidMap = this._addObject(
      comp.dict,
      undefined,
      comp.stream
    );
    (typeTwoFont.data as PdfDictionary).CIDToGIDMap = makeRef(cidToGidMap);

    const cmapStream = dedent`
      /CIDInit /ProcSet findresource begin
        12 dict begin
        begincmap
            /CIDSystemInfo
            <<
              /Registry (Adobe)
              /Ordering (UCS)
              /Supplement 0
            >> def
            /CMapName /Adobe-Identify-UCS def
            /CMapType 2 def
            1 begincodespacerange
            <0000> <FFFF>
            endcodespacerange
            1 beginbfrange
            <0000> <FFFE> <0000>
            endbfrange
        endcmap
        CMapName currentdict /CMap defineresource pop
        end
    end`;
    const cmap = this._addObject(
      {
        Length: cmapStream.length,
      },
      undefined,
      cmapStream
    );
    (typeZeroFont.data as PdfDictionary).ToUnicode = makeRef(cmap);

    const fontDesc = this._addObject({
      Type: '/FontDescriptor',
      FontName: '/GlyphLessFont',
      FontBBox: [0, 0, 1000 / CHAR_WIDTH, 1000],
      Ascent: 1000,
      CapHeight: 1000,
      Descent: -1,
      Flags: 5,
      ItalicAngle: 0,
      StemV: 80,
    });
    (typeTwoFont.data as PdfDictionary).FontDescriptor = makeRef(fontDesc);

    const fontDataObj = this._addObject(
      {
        Length: FONTDATA.length,
        Length1: FONTDATA.length,
      },
      undefined,
      FONTDATA
    );
    (fontDesc.data as PdfDictionary).FontFile2 = makeRef(fontDataObj);
  }

  _addOutline(
    itm: TocItem,
    parent: PdfObject,
    prev?: PdfObject
  ): [PdfObject, number] {
    const rec: PdfDictionary = {
      Title: `( ${itm.label} )`,
      Parent: makeRef(parent),
      // NOTE: The first entry is a number only during setup and will later be
      //       replaced with a reference to the actual page object, once we know
      //       how many objects are preceding the page objects.
      Dest: [itm.startCanvasIdx, '/Fit'],
    };
    const obj = this._addObject(rec);
    if (prev) {
      rec.Prev = makeRef(prev);
      (prev.data as PdfDictionary).Next = makeRef(obj);
    }
    if (itm.children?.length) {
      let prev: PdfObject | undefined;
      rec.Count = 0;
      for (const [idx, child] of itm.children.entries()) {
        const [childObj, numChildren] = this._addOutline(child, obj, prev);
        if (idx === 0) {
          rec.First = makeRef(childObj);
        } else if (idx === itm.children.length - 1) {
          rec.Last = makeRef(childObj);
        }
        rec.Count = rec.Count + 1 + numChildren;
      }
    }
    return [obj, (rec.Count as number) ?? 0];
  }

  _addObject(
    val: PdfDictionary,
    refName?: string,
    stream?: Uint8Array | string
  ): PdfObject {
    const obj = {
      num: this._nextObjNo,
      data: val,
      stream,
    };
    this._nextObjNo++;
    this._objects[obj.num] = obj;
    if (refName) {
      this._objRefs[refName] = makeRef(obj);
    }
    return obj;
  }

  /** Clone an object from a foreign PDF into the current PDF, adjusting
   *  the encountered indirect object references.
   */
  private async _transplantObject(
    parser: PdfParser,
    obj: PdfObject,
    seenObjects: Record<number, PdfRef> = {}
  ): Promise<PdfRef> {
    const handleValue = async (value: PdfValue): Promise<PdfValue> => {
      if (value instanceof PdfRef) {
        const o = await parser.resolveRef(value);
        if (o === undefined) {
          throw `Could not resolve reference to object '${value.refObj}'`;
        }
        // Check if we've already transplanted the object
        if (seenObjects[o.num]) {
          return seenObjects[o.num];
        }
        const objDict = o.data as PdfDictionary;
        const newObj = this._addObject(objDict, undefined, o.stream);
        const ref = new PdfRef(newObj.num);
        seenObjects[o.num] = ref;
        newObj.data = await handleValue(objDict);
        if (objDict.Type === '/Page') {
          // Redirect to our own Pages object
          (newObj.data as PdfDictionary).Parent = this._objRefs.Pages;
        }
        return ref;
      } else if (typeof value === 'string' && value[0] != '/') {
        return `(${value})`;
      } else if (Array.isArray(value)) {
        const out = [];
        for (const val of value) {
          out.push(await handleValue(val));
        }
        return out;
      } else if (typeof value === 'object' && value !== null) {
        const out: PdfDictionary = {};
        for (const [key, val] of Object.entries(value)) {
          // Ignore structure keys for now
          if (key === 'StructParent' || key === 'StructParents') {
            continue;
          }
          out[key] = await handleValue(val as PdfDictionary);
        }
        return out;
      }
      return value;
    };
    const ref = new PdfRef(obj.num);
    return (await handleValue(ref)) as PdfRef;
  }

  async insertCoverPages(pdfData: ArrayBuffer): Promise<void> {
    if (this._pagesStarted) {
      throw 'Cover pages must be inserted before writing the first regular page';
    }
    const reader = new ArrayReader(new Uint8Array(pdfData));
    const parser = await PdfParser.parse(reader);
    const pagesDict = this._objects[this._objRefs.Pages.refObj]
      .data as PdfDictionary;
    pagesDict.Kids = [];
    for await (const page of parser.pages()) {
      const dict = page.data as PdfDictionary;
      // Ignore associated structured content for now
      delete dict.StructParents;
      delete dict.Parent;
      const newPageRef = await this._transplantObject(parser, page);
      (pagesDict.Kids as PdfArray).push(newPageRef);
      (pagesDict.Count as number) += 1;
      this._numCoverPages += 1;
    }
    return;
  }

  async renderPage(
    {
      width: canvasWidth,
      height: canvasHeight,
    }: { width: number; height: number },
    imgData: ArrayBuffer,
    ocrText?: OcrPage,
    ppi = 300,
  ): Promise<void> {
    if (!this._pagesStarted) {
      log.debug('Initial page, finalizing PDF header structures.');
      if (this._pageLabels) {
        const catalog = this._objects[this._objRefs.Catalog.refObj]
          .data as PdfDictionary;
        catalog.PageLabels = makeRef(
          this._addObject({
            Nums: flatten(
              this._pageLabels
                .map((label, idx) =>
                  label
                    ? [idx + this._numCoverPages, { P: `( ${label} )` }]
                    : undefined
                )
                .filter((x) => x !== undefined) as PdfArray
            ),
          })
        );
      }
      const pagesObj = this._objects[this._objRefs.Pages.refObj];
      // Now that we know from which object number the pages start, we can set the
      // /Kids entry in the Pages object and update the outline destinations.
      const pageDict = pagesObj.data as PdfDictionary;
      const pageRefs = (pageDict.Kids ?? []) as PdfArray;
      pageDict.Kids = pageRefs.concat(
        range(
          this._nextObjNo,
          this._nextObjNo + this._numCanvases * this._objectsPerPage,
          this._objectsPerPage
        ).map(makeRef)
      );
      this._objects
        .filter((obj) => (obj.data as PdfDictionary)?.Dest !== undefined)
        .forEach((obj: PdfObject) => {
          const dest = (obj.data as PdfDictionary).Dest as PdfArray;
          if (typeof dest[0] !== 'number') {
            return;
          }
          dest[0] = makeRef(this._nextObjNo + dest[0] * this._objectsPerPage);
        });

      this._pagesStarted = true;
    }
    // Factor to multiply pixels by to get equivalent PDF units (72 pdf units === 1 inch)
    const unitScale = 72 / ppi;
    const pageDict = {
      Type: '/Page',
      Parent: this._objRefs.Pages,
      MediaBox: [0, 0, unitScale * canvasWidth, unitScale * canvasHeight],
      Resources: {
        ProcSet: ['/PDF', '/Text', '/ImageB', '/ImageI', '/ImageC'],
      },
    };
    if (ocrText && this._objRefs.Type0Font) {
      (pageDict.Resources as PdfDictionary).Font = {
        'f-0-0': this._objRefs.Type0Font,
      };
    }
    const page = this._addObject(pageDict);

    const contentOps = dedent`
      q
      ${unitScale * canvasWidth} 0 0 ${unitScale * canvasHeight} 0 0 cm
      /Im1 Do
      Q${ocrText ? '\n' + this._renderOcrText(ocrText, unitScale) : ''}
    `;
    log.debug('Trying to compress content stream.');
    const contentStreamComp = await tryDeflateStream(contentOps);
    const contentsObj = this._addObject(
      contentStreamComp.dict,
      undefined,
      contentStreamComp.stream
    );
    (page.data as PdfDictionary).Contents = makeRef(contentsObj);

    log.debug('Creating image object.');
    const image = PdfImage.open(new Uint8Array(imgData));
    const imageObjs = image.toObjects(this._nextObjNo);
    this._nextObjNo += imageObjs.length;
    this._objects.push(...imageObjs);
    ((page.data as PdfDictionary).Resources as PdfDictionary).XObject = {
      Im1: makeRef(imageObjs[0]),
    };

    // Write out all of the objects
    log.debug('Flushing data for page');
    await this._flush();
    log.debug('Finished rendering page');
  }

  /** Get PDF instructions to render a hidden text layer with the page's OCR.
   * 
   * This owes *a lot* to Tesseract's PDF renderer[1] and the IA's `pdf-tools`[2]
   * that ported it to Python. Accordingly, the license of this method is Apache 2.0.
   * 
   * [1] https://github.com/tesseract-ocr/tesseract/blob/5.0.0-beta-20210916/src/api/pdfrenderer.cpp
   * [2] https://github.com/internetarchive/archive-pdf-tools/blob/master/internetarchivepdf/pdfrenderer.py
   *
   *                            Apache License
   *                     Version 2.0, January 2004
   *                  http://www.apache.org/licenses/
   */
  _renderOcrText(ocr: OcrPage, unitScale: number): string {
    // TODO: Handle changes in writing direction!
    // TODO: Handle baselines, at least the simple ``cx+d` skewed-line-type, proper polyline support
    //       requires a per-character transformation matrix, which is a bit much for the current
    //       MVP-ish state
    const fontRef = '/f-0-0';
    const ops: Array<string> = [];
    ops.push('BT');  // Begin text rendering
    ops.push('3 Tr');  // Use "invisible ink" (no fill, no stroke)
    const scaleX = 1;
    const scaleY = 1;
    const shearX = 0;
    const shearY = 0;
    const pageHeight = ocr.height;
    /*
    ops.push(`${fontRef} 32 Tf`);
    ops.push(`${scaleX} ${shearX} ${shearY} ${scaleY} 0 ${pageHeight * unitScale - 0.78 * 32} Tm`);
    ops.push(`${serialize(toUTF16BE("TOP LEFT OF HOCR PAGE"))} TJ`);
    */
    for (const line of ocr.lines) {
      // Approximated font size for western scripts, PDF font size is specified in multiples of
      // 'user units', which default to 1/72inch. The `userScale` gives us the units per pixel.
      const fontSize = line.height * unitScale * 0.75;
      //const fontSize = 8; // TODO: This is what Tesseract uses, why does this work?
      ops.push(`${fontRef} ${fontSize} Tf`);
      // We use a text matrix for every line. Tesseract uses a per-paragraph matrix, but we don't
      // neccesarily have block/paragraph information available, so we'll use the next-closest
      // thing. This means that every word on the line is positioned relative to the line, not
      // relative to the page as in the markup.
      const xPos = line.x * unitScale;
      const lineY = pageHeight - line.y - line.height * 0.75
      const yPos = lineY * unitScale;
      ops.push(`${scaleX} ${shearX} ${shearY} ${scaleY} ${xPos} ${yPos} Tm`);
      let xOld = 0;
      let yOld = 0;
      for (const word of line.spans) {
        if (!word.text) {
          continue;
        }
        if (word.isExtra || !word.width) {
        // TODO: What to do if word.isExtra?
          continue;
        }
        // Position drawing with relative moveto
        const wordX = (word.x - line.x) * unitScale;
        // Convert beween different y-origins in OCR and PDF
        const wordYAbsolute = pageHeight - word.y - word.height * 0.75;
        const wordY = (wordYAbsolute - lineY) * unitScale;
        const wordWidth = word.width * unitScale;
        const wordHeight = word.height * unitScale;
        const dx = wordX - xOld;
        const dy = wordY - yOld;
        ops.push(`${dx * scaleX + dy * shearX} ${dx * shearY + dy * scaleY} Td`);
        xOld = wordX;
        yOld = wordY;
        // Calculate horizontal stretch
        // FIXME: This is ripped straight from Tesseract, I have no clue what it does
        // FIXME: The end of the line seems to be too far to the left sometimes,
        // while the start seems to match
        const wordLength = Math.pow(Math.pow(wordWidth, 2) + Math.pow(wordHeight, 2), 0.5);
        const pdfWordLen = word.text.length;
        ops.push(`${CHAR_WIDTH * (100 * wordLength / (fontSize * pdfWordLen))} Tz`);
        // FIXME: Account for trailing space in width calculation to prevent readers
        //        from inserting a line break
        const textBytes = serialize(toUTF16BE(word.text + ' ', false));
        ops.push(`[ ${textBytes} ] TJ`);
      }
      // Add a newline to visually group together all statements belonging to a line
      ops.push('')
    }
    ops.push('ET');
    return ops.join('\n');
  }

  get bytesWritten(): number {
    return this._offset;
  }

  async _flush(): Promise<void> {
    if (this._offsets.length === 0) {
      log.debug('Writing PDF header');
      await this._write(`%PDF-1.5\n%\xde\xad\xbe\xef\n`);
    }
    for (const obj of this._objects) {
      if (!obj) {
        continue;
      }
      log.debug(`Serializing object #${obj.num}`);
      await this._serializeObject(obj);
    }
    this._objects = [];
  }

  async _serializeObject(obj: PdfObject): Promise<void> {
    this._offsets.push(this._offset);
    const { num, data, stream } = obj;
    await this._write(`${num} 0 obj\n`);
    if (data) {
      await this._write(serialize(data));
    }
    if (stream) {
      await this._write('\nstream\n');
      await this._write(stream);
      await this._write('\nendstream');
    }
    await this._write('\nendobj\n');
  }

  async _write(data: Uint8Array | string): Promise<void> {
    if (this._writer === undefined) {
      throw new Error(
        'Cannot perform mutating operations on an already closed PDFGenerator.'
      );
    }
    if (typeof data === 'string') {
      data = textEncoder.encode(data);
    }
    this._offset += data.byteLength;
    await this._writer.write(data);
  }

  async end(): Promise<void> {
    if (!this._writer) {
      return;
    }
    type XrefEntry = [number, number, 'f' | 'n'];
    const xrefEntries: Array<XrefEntry> = [
      [0, 65535, 'f'],
      ...this._offsets.map((offset): XrefEntry => [offset, 0, 'n']),
    ];
    const xRefTable = xrefEntries
      .map(([off, gen, free]) =>
        [
          pad(off.toString(10), 10, '0'),
          pad(gen.toString(10), 5, '0'),
          free,
          '',
        ].join(' ')
      )
      .join('\n');
    const xrefOffset = this._offset;
    await this._write(`xref\n0 ${xrefEntries.length}\n${xRefTable}`);
    const trailerDict: PdfDictionary = {
      Size: xrefEntries.length,
      Root: this._objRefs.Catalog,
      Info: this._objRefs.Info,
      ID: [randomData(32), randomData(32)],
    };
    await this._write(`\ntrailer\n${serialize(trailerDict)}`);
    await this._write(`\nstartxref\n${xrefOffset}\n%%EOF`);
    await this._writer.waitForDrain;
    await this._writer.close();
    this._writer = undefined;
  }
}
