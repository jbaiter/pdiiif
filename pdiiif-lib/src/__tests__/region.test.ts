import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import fetchMock from 'jest-fetch-mock';
import tmp from 'tmp';

import fs from 'fs';
import path from 'path';

import { fetchCanvasData, getCropRect } from '../download';
import {
  getCanvasInfo,
  getImageInfos,
  getRegionFromSelector,
  vault,
} from '../iiif';
import { NodeWriter } from '../io';
import PDFGenerator from '../pdf/generator';
import type { CanvasNormalized } from '@iiif/presentation-3-normalized';

const FIXTURES = path.resolve(__dirname, './fixtures');

/** Two images on one canvas, the second one with a region (Level 0 services). */
async function loadCanvas(): Promise<CanvasNormalized> {
  const manifest = JSON.parse(
    await fs.promises.readFile(path.join(FIXTURES, 'region_target.json'), 'utf8')
  );
  const loaded = await vault.loadManifest(manifest.id, manifest);
  if (!loaded) {
    throw new Error('Could not load the manifest');
  }
  return vault.get<CanvasNormalized>(loaded.items[0]);
}

describe('getCropRect', () => {
  it('should convert regions to coordinates relative to the image', () => {
    expect(getCropRect('1768,2423,1768,2080', 3536, 4999)).toEqual({
      x: 0.5,
      y: 2423 / 4999,
      width: 0.5,
      height: 2080 / 4999,
    });
    expect(getCropRect('pct:10,20,50,25')).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.5,
      height: 0.25,
    });
    expect(getCropRect('square', 200, 100)).toEqual({
      x: 0.25,
      y: 0,
      width: 0.5,
      height: 1,
    });
    // Only the part inside of the image counts
    expect(getCropRect('50,50,100,100', 100, 100)).toEqual({
      x: 0.5,
      y: 0.5,
      width: 0.5,
      height: 0.5,
    });
  });

  it('should return nothing if the whole image is selected', () => {
    expect(getCropRect('full', 100, 100)).toBeUndefined();
    expect(getCropRect('0,0,150,150', 100, 100)).toBeUndefined();
  });

  it('should fail for malformed regions or regions outside of the image', () => {
    expect(() => getCropRect('200,200,50,50', 100, 100)).toThrow(/outside/);
    expect(() => getCropRect('10,10,50', 100, 100)).toThrow(/four numbers/);
  });
});

describe('getRegionFromSelector', () => {
  it('should read ImageApiSelectors and media fragments', () => {
    expect(
      getRegionFromSelector({ type: 'ImageApiSelector', region: '1,2,3,4' })
    ).toBe('1,2,3,4');
    expect(
      getRegionFromSelector({ type: 'FragmentSelector', value: 'xywh=1,2,3,4' })
    ).toBe('1,2,3,4');
    expect(
      getRegionFromSelector({ type: 'ImageApiSelector', region: 'full' })
    ).toBeUndefined();
  });
});

describe('Images with a region', () => {
  it('should place images as given by the target and find the region', async () => {
    const images = getImageInfos(await loadCanvas());
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({ x: 8, y: 1, width: 575, height: 903 });
    expect(images[0].region).toBeUndefined();
    expect(images[1]).toMatchObject({
      x: 587,
      y: 226,
      width: 448,
      height: 1396,
      region: '224,156,369,1149',
    });
  });

  it('should fetch the full image (also for Level 0) and attach the crop', async () => {
    fetchMock.resetMocks();
    const imgBuf = await fs.promises.readFile(path.join(FIXTURES, 'wunder.jpg'));
    fetchMock.mockResponse(async (req) =>
      req.url.endsWith('/info.json')
        ? JSON.stringify({
            '@context': 'http://iiif.io/api/image/2/context.json',
            '@id': req.url.replace('/info.json', ''),
            profile: 'http://iiif.io/api/image/2/level0.json',
            width: 1041,
            height: 1634,
          })
        : { body: imgBuf as any, headers: { 'Content-Type': 'image/jpeg' } }
    );
    const canvas = await loadCanvas();
    const data = await fetchCanvasData(canvas, getCanvasInfo(canvas).images, {});

    expect(data?.imageFailures).toHaveLength(0);
    expect(data?.images).toHaveLength(2);
    expect(data?.images[0].crop).toBeUndefined();
    expect(data?.images[1].crop).toEqual({
      x: 224 / 1041,
      y: 156 / 1634,
      width: 369 / 1041,
      height: 1149 / 1634,
    });
    // No region requests, Level 0 can't do them
    const imageUrls = fetchMock.mock.calls
      .map(([url]) => String(typeof url === 'string' ? url : (url as Request).url))
      .filter((url) => url.endsWith('.jpg'));
    expect(imageUrls.every((url) => url.includes('/full/'))).toBe(true);
  });
});

describe('Painting a cropped image into the PDF', () => {
  it('should clip to the target and place the full image so that the crop fills it', async () => {
    const pdfPath = tmp.tmpNameSync({ prefix: 'pdiiif-test-', postfix: '.pdf' });
    const canvasId = 'http://some.fixture/canvas';
    const pdfgen = new PDFGenerator({
      writer: new NodeWriter(fs.createWriteStream(pdfPath)),
      metadata: {},
      langPref: ['en'],
      canvasInfos: [
        {
          canvas: { id: canvasId, type: 'Canvas' },
          images: [
            { resource: { id: 'foo', type: 'Image' }, x: 0, y: 0, width: 290, height: 400 },
          ],
          numAnnotations: 0,
        },
      ],
      outline: [],
      pageLabels: ['1'],
    });
    await pdfgen.setup();
    const imgBuf = await fs.promises.readFile(path.join(FIXTURES, 'wunder.jpg'));
    await pdfgen.renderPage(
      canvasId,
      { width: 290, height: 400 },
      [
        {
          resource: { id: 'someid', type: 'Image' },
          width: 290,
          height: 400,
          x: 0,
          y: 0,
          data: imgBuf,
          numBytes: imgBuf.length,
          corsAvailable: true,
          format: 'jpeg',
          // Right half of the image, starting a quarter from the top
          crop: { x: 0.5, y: 0.25, width: 0.5, height: 0.5 },
        },
      ],
      [],
      undefined,
      72
    );
    await pdfgen.end();

    const pdfData = await fs.promises.readFile(pdfPath);
    fs.unlinkSync(pdfPath);
    const parsed = await PDFDocument.load(pdfData.buffer.slice(0) as ArrayBuffer, {
      throwOnInvalidObject: false,
    });
    const contents = parsed.getPage(0).node.Contents() as PDFRawStream;
    const content = Buffer.from(decodePDFRawStream(contents).decode()).toString('latin1');
    // The full image is twice the size of the page, shifted left by one page
    // width and down by a quarter of the image height
    expect(content).toContain('q 0 0 290 400 re W n');
    expect(content).toContain('580 0 0 800 -290 -200 cm');
  });
});
