import { PDFDocument } from 'pdf-lib';
import tmp from 'tmp';

import fs from 'fs';
import path from 'path';
import { makeRef, serialize } from '../pdf/common';
import PDFGenerator from '../pdf/generator';
import { NodeWriter } from '../io';

describe('JavaScript->PDF value serialization', () => {
  it('should convert Unicode strings with braces to UTF16BE', () => {
    expect(serialize('(Hellö Wörld)')).toBe(
      '<FEFF00480065006C006C00F60020005700F60072006C0064>'
    );
  });
  it('should not convert ASCII strings', () => {
    expect(serialize('(Hello World)')).toBe('(Hello World)');
  });
  it('should not convert strings without braces', () => {
    expect(serialize('HelloWorld')).toBe('HelloWorld');
  });
  it('should convert Uint8Arrays to a hex string', () => {
    expect(serialize(new Uint8Array([0, 16, 32, 64, 128, 256]))).toBe(
      '<001020408000>'
    );
  });
  it('should convert Dates to a PDF date string', () => {
    expect(serialize(new Date('01 Jan 1970 00:00:00 GMT'))).toBe(
      '(D:19700101000000Z)'
    );
  });
  it('should convert objects to dictionaries', () => {
    expect(serialize({ Foo: 'bar' })).toBe('<<\n  /Foo bar\n>>');
  });
  it('should correctly encode PDF references', () => {
    expect(serialize(makeRef(15))).toBe('15 0 R');
    expect(serialize(makeRef({ num: 32 }))).toBe('32 0 R');
  });
});

describe('PDF generation', () => {
  it('should initialize a PDF with the correct metadata', async () => {
    const pdfPath = tmp.tmpNameSync({
      prefix: 'pdiiif-test-',
      postfix: '.pdf',
    });
    const nodeStream = fs.createWriteStream(pdfPath);
    const writer = new NodeWriter(nodeStream);
    const metadata = {
      Title: 'Täst Tütle',
    };
    const pdfgen = new PDFGenerator({
      writer,
      metadata,
      langPref: ['en'],
      canvasInfos: [
        {
          canvas: { id: 'foo', type: 'Canvas' },
          images: [
            {
              resource: { id: 'foo', type: 'Image' },
              x: 0,
              y: 0,
              width: 1024,
              height: 1024
            },
          ],
          numAnnotations: 0,
        },
      ],
      outline: [],
      pageLabels: ['Tüst Läbel']
  });
    await pdfgen.setup();
    const imgBuf = await fs.promises.readFile(
      path.resolve(__dirname, './fixtures/wunder.jpg')
    );
    await pdfgen.renderPage(
      'http://some.fixture',
      { width: 290, height: 400 },
      [
        {
          resource: { id: 'someid', type: 'Image' },
          width: 290, height: 400,
          x: 0, y: 0,
          data: imgBuf,
          numBytes: imgBuf.length,
          corsAvailable: true,
          choiceInfo: {
            enabled: true,
            optional: false,
            visibleByDefault: true
          },
          format: 'jpeg',
        },
      ],
      [],
      undefined,
      72
    );
    await pdfgen.end();

    const pdfData = await fs.promises.readFile(pdfPath);
    const parsed = await PDFDocument.load(pdfData.buffer.slice(0), {
      throwOnInvalidObject: false,
    });
    expect(parsed.getPageCount()).toBe(1);
    expect(parsed.getPage(0).getSize()).toMatchObject({
      width: 290,
      height: 400,
    });
    expect(parsed.getTitle()).toEqual('Täst Tütle');
    fs.unlinkSync(pdfPath);
  });
});
