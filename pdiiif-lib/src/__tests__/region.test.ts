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
const IMAGE_SERVICE_ID =
  'https://iiif.io/api/image/3.0/example/reference/4ce82cef49fb16798f4c2440307c3d6f-newspaper-p2';

describe('getCropRect', () => {
  it('should convert pixel regions to relative coordinates', () => {
    expect(getCropRect('1768,2423,1768,2080', 3536, 4999)).toEqual({
      x: 0.5,
      y: 2423 / 4999,
      width: 0.5,
      height: 2080 / 4999,
    });
  });

  it('should convert percentage regions without needing the image size', () => {
    expect(getCropRect('pct:10,20,50,25')).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.5,
      height: 0.25,
    });
  });

  it('should center square regions along the longer side', () => {
    expect(getCropRect('square', 200, 100)).toEqual({
      x: 0.25,
      y: 0,
      width: 0.5,
      height: 1,
    });
  });

  it('should return nothing if the whole image is selected', () => {
    expect(getCropRect('full', 100, 100)).toBeUndefined();
    expect(getCropRect('0,0,100,100', 100, 100)).toBeUndefined();
    expect(getCropRect('0,0,150,150', 100, 100)).toBeUndefined();
    expect(getCropRect('pct:0,0,100,100')).toBeUndefined();
  });

  it('should only use the part of the region that is inside the image', () => {
    expect(getCropRect('50,50,100,100', 100, 100)).toEqual({
      x: 0.5,
      y: 0.5,
      width: 0.5,
      height: 0.5,
    });
  });

  it('should fail for regions outside of the image or malformed regions', () => {
    expect(() => getCropRect('200,200,50,50', 100, 100)).toThrow(/outside/);
    expect(() => getCropRect('10,10,0,50', 100, 100)).toThrow(/positive/);
    expect(() => getCropRect('10,10,50', 100, 100)).toThrow(/four numbers/);
    expect(() => getCropRect('pct:a,b,c,d')).toThrow(/four numbers/);
    expect(() => getCropRect('pct:1,,3,4')).toThrow(/four numbers/);
  });

  it('should paint the whole image if pixels are given, but the size is unknown', () => {
    expect(getCropRect('10,10,50,50')).toBeUndefined();
  });
});

describe('getRegionFromSelector', () => {
  it('should read the region of an ImageApiSelector', () => {
    expect(
      getRegionFromSelector({ type: 'ImageApiSelector', region: '1,2,3,4' })
    ).toBe('1,2,3,4');
    expect(
      getRegionFromSelector([{ type: 'ImageApiSelector', region: 'pct:1,2,3,4' }])
    ).toBe('pct:1,2,3,4');
  });

  it('should treat the full region like no selection', () => {
    expect(
      getRegionFromSelector({ type: 'ImageApiSelector', region: 'full' })
    ).toBeUndefined();
    expect(getRegionFromSelector({ type: 'ImageApiSelector' })).toBeUndefined();
    expect(getRegionFromSelector(undefined)).toBeUndefined();
  });

  it('should read media fragment selectors', () => {
    const frag = (value: string) => ({
      type: 'FragmentSelector',
      conformsTo: 'http://www.w3.org/TR/media-frags/',
      value,
    });
    expect(getRegionFromSelector(frag('xywh=10,20,30,40'))).toBe('10,20,30,40');
    expect(getRegionFromSelector(frag('xywh=pixel:10,20,30,40'))).toBe(
      '10,20,30,40'
    );
    expect(getRegionFromSelector(frag('xywh=percent:10,20,30,40'))).toBe(
      'pct:10,20,30,40'
    );
  });

  it('should ignore unsupported selectors', () => {
    expect(
      getRegionFromSelector({ type: 'SvgSelector', value: '<svg/>' })
    ).toBeUndefined();
  });
});

let manifestCounter = 0;

/** Load the recipe manifest, optionally modified, into the (global) vault. */
async function loadRecipeCanvas(
  mutate?: (manifest: any) => void
): Promise<CanvasNormalized> {
  // The vault caches by ID, so every loaded variant needs its own IDs
  const json = (
    await fs.promises.readFile(path.join(FIXTURES, 'region_recipe.json'), 'utf8')
  ).replace(/0299-region/g, `0299-region-${manifestCounter++}`);
  const manifest = JSON.parse(json);
  mutate?.(manifest);
  const loaded = await vault.loadManifest(manifest.id, manifest);
  if (!loaded) {
    throw new Error('Could not load the manifest');
  }
  return vault.get<CanvasNormalized>(loaded.items[0]);
}

describe('Images with a region (IIIF Cookbook recipe 0299)', () => {
  it('should find the image and its region in a SpecificResource', async () => {
    const canvas = await loadRecipeCanvas();
    const images = getImageInfos(canvas);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      region: '1768,2423,1768,2080',
      // Painted on the whole canvas
      x: 0,
      y: 0,
      width: 1768,
      height: 2080,
      nativeWidth: 3536,
      nativeHeight: 4999,
      format: 'jpeg',
    });
    expect(images[0].resource.id).toBe(`${IMAGE_SERVICE_ID}/full/max/0/default.jpg`);
  });

  it('should still find plain images without a region', async () => {
    const canvas = await loadRecipeCanvas((manifest) => {
      const anno = manifest.items[0].items[0].items[0];
      anno.body = anno.body.source;
    });
    const images = getImageInfos(canvas);
    expect(images).toHaveLength(1);
    expect(images[0].region).toBeUndefined();
  });

  describe.each(['level0', 'level1', 'level2'])(
    'with a %s image service',
    (profile) => {
      beforeEach(() => {
        fetchMock.resetMocks();
      });

      it('should fetch the full image and attach the relative crop', async () => {
        const imgBuf = await fs.promises.readFile(
          path.join(FIXTURES, 'wunder.jpg')
        );
        fetchMock.mockResponse(async (req) => {
          if (req.url.endsWith('/info.json')) {
            return JSON.stringify({
              '@context': 'http://iiif.io/api/image/3/context.json',
              id: IMAGE_SERVICE_ID,
              type: 'ImageService3',
              protocol: 'http://iiif.io/api/image',
              profile,
              width: 3536,
              height: 4999,
            });
          }
          return {
            body: imgBuf as any,
            headers: { 'Content-Type': 'image/jpeg' },
          };
        });
        const canvas = await loadRecipeCanvas((manifest) => {
          manifest.items[0].items[0].items[0].body.source.service[0].profile =
            profile;
        });
        const canvasData = await fetchCanvasData(
          canvas,
          getCanvasInfo(canvas).images,
          {}
        );

        // Never a region or tile request, since level 0 can't do them
        const imageRequests = fetchMock.mock.calls
          .map(([url]) => String(typeof url === 'string' ? url : (url as Request).url))
          .filter((url) => !url.endsWith('/info.json') && url.startsWith(IMAGE_SERVICE_ID));
        expect(imageRequests).toEqual([`${IMAGE_SERVICE_ID}/full/max/0/default.jpg`]);

        expect(canvasData?.imageFailures).toHaveLength(0);
        expect(canvasData?.images).toHaveLength(1);
        expect(canvasData?.images[0].crop).toEqual({
          x: 0.5,
          y: 2423 / 4999,
          width: 0.5,
          height: 2080 / 4999,
        });
      });
    }
  );

  it('should report a region outside of the image as a failed image', async () => {
    fetchMock.resetMocks();
    fetchMock.mockResponse(async () => JSON.stringify({}));
    const canvas = await loadRecipeCanvas((manifest) => {
      const body = manifest.items[0].items[0].items[0].body;
      body.selector.region = '9000,9000,100,100';
      body.source.service[0].width = 3536;
      body.source.service[0].height = 4999;
    });
    const canvasData = await fetchCanvasData(
      canvas,
      getCanvasInfo(canvas).images,
      {}
    );
    expect(canvasData?.images).toHaveLength(0);
    expect(canvasData?.imageFailures).toHaveLength(1);
    expect(String(canvasData?.imageFailures[0].cause)).toMatch(/outside/);
  });
});

describe('Painting a cropped image into the PDF', () => {
  async function renderWithCrop(
    crop: { x: number; y: number; width: number; height: number } | undefined
  ): Promise<string> {
    const pdfPath = tmp.tmpNameSync({ prefix: 'pdiiif-test-', postfix: '.pdf' });
    const writer = new NodeWriter(fs.createWriteStream(pdfPath));
    const canvasId = 'http://some.fixture/canvas';
    const pdfgen = new PDFGenerator({
      writer,
      metadata: {},
      langPref: ['en'],
      canvasInfos: [
        {
          canvas: { id: canvasId, type: 'Canvas' },
          images: [
            {
              resource: { id: 'foo', type: 'Image' },
              x: 0,
              y: 0,
              width: 290,
              height: 400,
            },
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
          crop,
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
    return Buffer.from(decodePDFRawStream(contents).decode()).toString('latin1');
  }

  it('should clip and scale the full image to show only the cropped part', async () => {
    // Show the bottom right quarter of the image
    const content = await renderWithCrop({
      x: 0.5,
      y: 0.5,
      width: 0.5,
      height: 0.5,
    });
    // Clip to the page, scale the image to twice the page size and move it
    // so that its bottom right quarter fills the page.
    expect(content).toContain('q 0 0 290 400 re W n');
    expect(content).toContain('580 0 0 800 -290 0 cm');
    expect(content).toContain('/Im1 Do');
  });

  it('should place the image correctly for a crop in the middle', async () => {
    const content = await renderWithCrop({
      x: 0.5,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    });
    expect(content).toContain('q 0 0 290 400 re W n');
    expect(content).toContain('580 0 0 800 -290 -200 cm');
  });

  it('should not clip images without a crop', async () => {
    const content = await renderWithCrop(undefined);
    expect(content).toContain('q 290 0 0 400 0 0 cm');
    expect(content).not.toContain(' re W n');
  });
});

describe('Placement of images via the annotation target', () => {
  it('should place regions and full images on the canvas as given by the xywh target', async () => {
    const json = await fs.promises.readFile(
      path.join(FIXTURES, 'region_target.json'),
      'utf8'
    );
    const manifest = JSON.parse(json);
    const loaded = await vault.loadManifest(manifest.id, manifest);
    if (!loaded) {
      throw new Error('Could not load the manifest');
    }
    const canvas = vault.get<CanvasNormalized>(loaded.items[0]);
    const images = getImageInfos(canvas);
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
});
