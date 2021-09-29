/* eslint-disable no-new-wrappers */
/* eslint-disable @typescript-eslint/no-non-null-assertion */

/// PDF generation code
import flatten from 'lodash/flatten';
import range from 'lodash/range';
import pad from 'lodash/padStart';
import dedent from 'dedent-js';
import Pako from 'pako';

import {
  Metadata,
  PdfObject,
  PdfDictionary,
  makeRef,
  PdfArray,
  PdfRef,
  serialize,
} from './pdf';
import { TocItem, textEncoder, randomData } from './util';
import { Writer } from '../writers';
import PdfImage from './image';
import { sRGBIEC1966_21 as srgbColorspace } from '../res/srgbColorspace';

const PRODUCER = 'pdiiif v0.1.0';
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

  constructor(
    writer: Writer,
    metadata: Metadata,
    numCanvases: number,
    pageLabels?: string[],
    outline: TocItem[] = [],
    hasText = false
  ) {
    this._writer = writer;
    const catalog: PdfDictionary = {
      Type: '/Catalog',
    };
    this._addObject(catalog, 'Catalog');

    const pagesObj = this._addObject(
      {
        Type: '/Pages',
        Count: numCanvases,
      },
      'Pages'
    );
    catalog.Pages = makeRef(pagesObj);

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

    if (pageLabels) {
      catalog.PageLabels = makeRef(
        this._addObject({
          Nums: flatten(
            pageLabels
              .map((label, idx) =>
                label ? [idx, { P: `( ${label} )` }] : undefined
              )
              .filter((x) => x !== undefined) as PdfArray
          ),
        })
      );
    }
    if (outline.length > 0) {
      catalog.PageMode = 'UseOutlines';
      const outlines: PdfDictionary = {
        Type: '/Outlines',
        Count: 0,
      };
      const outlinesObj = this._addObject(outlines);
      catalog.Outlines = makeRef(outlinesObj);
      let prev: PdfObject | undefined;
      for (const [idx, itm] of outline.entries()) {
        const [childObj, numKids] = this._addOutline(itm, outlinesObj, prev);
        (outlines.Count as number) += (1 + numKids);
        if (idx === 0) {
          outlines.First = makeRef(childObj);
        } else if (idx === outline.length - 1) {
          outlines.Last = makeRef(childObj);
        }
        prev = childObj;
      }
    }
    if (hasText) {
      this._setupHiddenTextFont();
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
    const colorSpaceCompressed = Pako.deflate(srgbColorspace);
    const colorSpace = this._addObject(
      {
        N: 3,
        Length: colorSpaceCompressed.length,
        Filter: '/FlateDecode',
      },
      undefined,
      colorSpaceCompressed
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

    // Now that we know from which object number the pages start, we can set the
    // /Kids entry in the Pages object and update the outline destinations.
    (pagesObj.data as PdfDictionary).Kids = range(
      this._nextObjNo,
      this._nextObjNo + (numCanvases * this._objectsPerPage),
      this._objectsPerPage
    ).map(makeRef);
    this._objects
      .filter((obj) => (obj.data as PdfDictionary)?.Dest !== undefined)
      .forEach((obj: PdfObject) => {
        const dest = (obj.data as PdfDictionary).Dest as PdfArray;
        if (typeof dest[0] !== 'number') {
          return;
        }
        dest[0] = makeRef(this._nextObjNo + (dest[0] * this._objectsPerPage));
      });
  }

  _setupHiddenTextFont(): void {
    const typeZeroFont = this._addObject(
      {
        Type: '/Font',
        Subtype: '/Type0',
        BaseFont: '/GlyphlessFont',
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
    const comp = Pako.deflate(cidtoGidMapData);
    const cidToGidMap = this._addObject(
      {
        Length: comp.length,
        Filter: '/FlateDecode',
      },
      undefined,
      comp as Uint8Array
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
            <0000> <FFFF> <0000>
            endbfrange
        endcmap
        CMapName currentdict /CMap defineresource pop
        end
    end`;
    const cmap = this._addObject(
      {
        Length: cmapStream.length,
      },
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
    this._objects.push(obj);
    if (refName) {
      this._objRefs[refName] = makeRef(obj);
    }
    return obj;
  }

  renderPage(
    {
      width: canvasWidth,
      height: canvasHeight,
    }: { width: number; height: number },
    imgData: ArrayBuffer,
    ppi = 300
  ): Promise<void> {
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
    // FIXME: Should only be done if the page actually has text
    if (this._objRefs.Type0Font) {
      (pageDict.Resources as PdfDictionary).Font = {
        'f-0-0': this._objRefs.Type0Font,
      };
    }
    const page = this._addObject(pageDict);

    const contentStream = Pako.deflate(dedent`
      q
      ${unitScale * canvasWidth} 0 0 ${unitScale * canvasHeight} 0 0 cm
      /Im1 Do
      Q
    `);
    const contentsObj = this._addObject(
      {
        Length: contentStream.length,
        Filter: '/FlateDecode',
      },
      undefined,
      contentStream
    );
    (page.data as PdfDictionary).Contents = makeRef(contentsObj);

    const image = PdfImage.open(new Uint8Array(imgData));
    const imageObjs = image.toObjects(this._nextObjNo);
    this._nextObjNo += imageObjs.length;
    this._objects.push(...imageObjs);
    ((page.data as PdfDictionary).Resources as PdfDictionary).XObject = {
      Im1: makeRef(imageObjs[0]),
    };

    // Write out all of the objects
    return this._flush();
  }

  get bytesWritten(): number {
    return this._offset;
  }

  async _flush(): Promise<void> {
    if (this._offsets.length === 0) {
      await this._write(`%PDF-1.5\n%\xde\xad\xbe\xef\n`);
    }
    for (const obj of this._objects) {
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
    this._writer.write(data);
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
      Size: xRefTable.length,
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
