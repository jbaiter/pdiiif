/* eslint-disable no-await-in-loop */
import { Canvas, Manifest, Range as IIIFRange, TreeNode } from 'manifesto.js';
import fetch from 'cross-fetch';
import { minBy, orderBy } from 'lodash';
import { Writable, WritableOptions } from 'stream';

import PDFGenerator from './pdf';

var FALLBACK_PPI = 300;

/** Wraps a writable and counts the bytes written to it. */
class CountingWritable extends Writable {
  _stream: Writable;
  bytesWritten: number = 0;

  constructor(stream: Writable, options?: WritableOptions) {
    super(options);
    this._stream = stream;
  }

  _write(chunk: any, enc: string, cb: (error?: Error | null) => void) {
    this._stream._write(chunk, enc, cb);
    if (chunk instanceof Buffer) {
      this.bytesWritten += (chunk as Buffer).byteLength;
    }
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this._stream._destroy(error, callback);
  }

  _final(callback: (error?: Error | null) => void): void {
    this._stream._final(callback);
  }
}

/** Progress information for rendering a progress bar or similar UI elements. */
interface ProgressStatus {
  totalPages: number;
  pagesWritten: number;
  bytesWritten: number;
  /// Predicted size of the final file in bytes
  estimatedFileSize?: number;
}

/** Options for converting a IIIF Manifest to a PDF. */
interface ConvertOptions {
  /// Pixels per inch to assume for the full resolution version of each canvas.
  /// If not set, the conversion will use an available IIIF Physical Dimensions
  /// service to calculate the page dimensions instead.
  ppi?: number;
  /// Set of canvas ids to include in PDF, or a predicate to filter canvas identifiers
  /// by. By default, all canvases are included in the PDF.
  filterCanvases?: string[] | ((canvasId: string) => boolean);
  /// List of languages to use for metadata, page labels and table of contents, in
  /// descending order of preference. Will use the environment's locale settings by
  /// default.
  languagePreference?: string[] | string;
  /// Restrict the image size to include in the PDF. Only works with Level 2 Image API
  /// services that allow arbitrary downscaling, the conversion will not perform
  /// downscaling itself. For Level 1 endpoints, the closest available lower width
  /// will be selected.
  maxWidth?: number;
  /// Callback that gets called whenever a page has finished, useful to render a
  /// progress bar.
  onProgress?: (status: ProgressStatus) => void;
  /// Set PDF metadata, by default `Title` will be the manifest's label.
  metadata?: {
    CreationDate?: Date;
    Title?: string;
    Author?: string;
    Keywords?: string;
  };
}

/** Container for image size along with its corresponding IIIF Image API string. */
interface SizeInfo {
  iiifSize: string;
  width: number;
  height: number;
}

/** Calculate the image size to fetch, based on user constraints and available sizes
 *  in the Image API info.json response.
 */
function getImageSize(infoJson: any, requestedWidth?: number): SizeInfo {
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

function getPointsPerInch(
  infoJson: any,
  canvas: Canvas,
  imgWidth: number,
  ppiOverride?: number
): number {
  let physDimService: any = canvas
    .getServices()
    .find((service) => service.getProfile().indexOf('physdim') > 0);
  if (!physDimService && infoJson.service !== undefined) {
    let services = Array.isArray(infoJson.service)
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
    // TODO: Verify that this is correct
    ppi = 25.4 / physicalScale;
  } else if (physicalUnits === 'cm') {
    // TODO: Verify that this is correct
    ppi = 2.54 / physicalScale;
  } else {
    ppi = FALLBACK_PPI;
  }
  return ppi * (imgWidth / infoJson.width);
}

export async function convertManifest(
  /* eslint-disable  @typescript-eslint/explicit-module-boundary-types */
  manifestJson: any,
  outputStream: Writable,
  {
    filterCanvases = (canvasId) => true,
    languagePreference = [Intl.DateTimeFormat().resolvedOptions().locale],
    maxWidth,
    metadata = {},
    onProgress,
    ppi,
  }: ConvertOptions
): Promise<void> {
  const countingStream = new CountingWritable(outputStream);
  let canvasPredicate: (canvasId: string) => boolean;
  if (Array.isArray(filterCanvases)) {
    canvasPredicate = (canvasId) => filterCanvases.indexOf(canvasId) >= 0;
  } else {
    canvasPredicate = filterCanvases;
  }
  const manifest = new Manifest(manifestJson);

  const pdfMetadata = { ...metadata };
  if (!pdfMetadata.Title) {
    pdfMetadata.Title =
      manifest.getLabel().getValue(languagePreference) ?? undefined;
  }
  const pdfGen = new PDFGenerator(countingStream, pdfMetadata);

  const canvases = manifest
    .getSequenceByIndex(0)
    .getCanvases()
    .filter((c) => canvasPredicate(c.id));
  const totalCanvasPixels = canvases.reduce(
    (sum, canvas) => sum + canvas.getWidth() * canvas.getHeight(),
    0
  );
  const labels = canvases.map(
    (canvas) => canvas.getLabel().getValue(languagePreference) ?? ''
  );
  pdfGen.setPageLabels(labels);

  // ToC generation: IIIF's `Range` construct is so open, doing anything useful with it is a pain :-/
  // In our case, the pain comes from multiple directions:
  // - PDFs can only connect an outline node to a *single* page (IIIF connects ranges of pages)
  // - PDFKit can only add an outline item for the *current* page
  // - IIIF doesn't prescribe an order for the ranges or the canvases contained in them
  // Our approach is to pre-generate the range associated with each canvas and a hierarchy
  // of parent-child relationships for ranges.

  /// All canvas identifiers in the order they appear as in the sequence
  const canvasIds = canvases.map((canvas) => canvas.id);
  /// Keep track of all ranges belonging to a canvas (i.e. ranges it's the "first" canvas of) and their outline parent, if present
  const canvasRanges: { [canvasId: string]: { id: string; label: string } } =
    {};
  /// PDF Outline nodes associated with each IIIF Range
  const rangeOutlines: { [rangeId: string]: PDFKit.PDFOutline } = {};
  /// Parents for each IIIF Range
  const rangeParents: { [rangeId: string]: string[] } = {};

  let tocTree = manifest.getDefaultTree();
  if (!tocTree?.nodes?.length) {
    tocTree = manifest.getTopRanges()[0]?.getTree(new TreeNode('root'));
  }

  // We have to recurse, this small closure handles each node in the tree
  const handleNode = (node: TreeNode, parentId?: string): void => {
    let rangeId: string | undefined;
    if (node.isRange()) {
      const range = node.data as IIIFRange;
      if (parentId) {
        rangeParents[range.id] = [parentId, ...(rangeParents[parentId] ?? [])];
      }
      let firstCanvas;
      if (range.__jsonld.canvases) {
        firstCanvas = orderBy(range.__jsonld.canvases, (canvasId) =>
          canvasIds.indexOf(canvasId)
        )[0];
      } else if (range.__jsonld.members) {
        firstCanvas = orderBy(
          range.__jsonld.members.filter((m: any) => m['@type'] === 'sc:Canvas'),
          (canvas) => canvasIds.indexOf(canvas['@id'])
        )[0];
      } else if (range.__jsonld.items) {
        firstCanvas = orderBy(
          range.__jsonld.items.filter((m: any) => m.type === 'Canvas'),
          (canvas) => canvasIds.indexOf(canvas.id)
        )[0];
      }
      if (firstCanvas) {
        const rangeLabel = range.getLabel().getValue(languagePreference);
        if (rangeLabel) {
          canvasRanges[firstCanvas] = { id: range.id, label: rangeLabel };
        }
        rangeId = range.id;
      }
    }

    for (const childNode of node.nodes) {
      handleNode(childNode, rangeId);
    }
  };

  if (tocTree) {
    // Descend into the tree
    handleNode(tocTree);
  }

  let canvasPixels = 0;
  let pixelsWritten = 0;
  let pixelBytesFactor = undefined;
  let pixelScaleFactor = 1;
  for (let canvasIdx = 0; canvasIdx < canvases.length; canvasIdx++) {
    const canvas = canvases[canvasIdx];
    const img = canvas.getImages()[0].getResource();
    const imgService = img.getServices()[0];
    const infoJson = await (await fetch(`${imgService.id}/info.json`)).json();
    const { iiifSize, width, height } = getImageSize(infoJson, maxWidth);
    const imgUrl = `${imgService.id}/full/${iiifSize}/0/default.jpg`;
    const imgResp = await fetch(imgUrl);
    if (imgResp.status >= 400) {
      throw new Error(
        `Failed to fetch page image from ${imgUrl}, server returned status ${imgResp.status}`
      );
    }
    const imgData = await imgResp.arrayBuffer();

    pdfGen.renderPage(
      { width, height },
      imgData,
      getPointsPerInch(infoJson, canvas, width, ppi)
    );

    pixelsWritten += width * height;
    canvasPixels += canvas.getWidth() * canvas.getHeight();
    pixelScaleFactor = pixelsWritten / canvasPixels;
    pixelBytesFactor = countingStream.bytesWritten / pixelsWritten;

    const rangeInfo = canvasRanges[canvas.id];
    if (rangeInfo) {
      const { label: rangeLabel, id: rangeId } = rangeInfo;
      const parentId = rangeParents[rangeId]?.[0];
      let parentOutline;
      if (parentId) {
        parentOutline = rangeOutlines[parentId];
      }
      rangeOutlines[rangeId] = pdfGen.addTocItem(rangeLabel, parentOutline);
    }
    onProgress?.({
      pagesWritten: canvasIdx + 1,
      totalPages: canvases.length,
      bytesWritten: countingStream.bytesWritten,
      estimatedFileSize:
        pixelBytesFactor * pixelScaleFactor * totalCanvasPixels,
    });
  }
  pdfGen.close();
}
