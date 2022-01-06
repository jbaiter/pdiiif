import max from 'lodash/max';

export interface ManifestInfo {
  label: string;
  previewImageUrl?: string;
  manifestJson: any;
  maximumImageWidth: number;
  supportsDownscale: boolean;
  imageApiHasCors: boolean;
}

// TODO: Use manifesto.js for i18n and better 2/3 cross-compatibility
export async function fetchManifestInfo(
  manifestUrl: string
): Promise<ManifestInfo> {
  const manifestResp = await fetch(manifestUrl);
  const manifestJson = await manifestResp.json();

  const iiifContext = Array.isArray(manifestJson['@context'])
    ? manifestJson['@context'].find((c) =>
        c.startsWith('http://iiif.io/api/presentation/')
      )
    : manifestJson['@context'];
  const isIIIFv3 = iiifContext.indexOf('/presentation/3') > 0;
  const canvases = isIIIFv3
    ? manifestJson.items.filter((i) => i.type === 'Canvas')
    : manifestJson.sequences?.[0]?.canvases;
  const canvasIds = canvases.map((c) => c.id ?? c['@id']);
  let images = isIIIFv3
    ? canvases.map(
        (c) =>
          c.items
            .find((i) => i.type === 'AnnotationPage')
            ?.items?.find((i) => i.motivation === 'painting')?.body
      )
    : canvases.map(
        (c) => c.images.find((i) => i.motivation === 'sc:painting')?.resource
      );

  let preview;
  if (manifestJson.thumbnail) {
    preview = isIIIFv3 ? manifestJson.thumbnail[0] : manifestJson.thumbnail;
  } else {
    let startCanvasId;
    if (isIIIFv3) {
      if (manifestJson.start) {
        startCanvasId =
          manifestJson.start.type === 'Canvas'
            ? manifestJson.start.id
            : manifestJson.start.source;
      } else {
        startCanvasId = canvases[0].id;
      }
    } else {
      startCanvasId = manifestJson.startCanvas ?? canvases[0]['@id'];
    }
    preview = images[canvasIds.indexOf(startCanvasId)];
  }
  let previewImageUrl;
  if (preview.service) {
    const service = isIIIFv3 ? preview.service[0].id : preview.service['@id'];
    previewImageUrl = `${service}/full/300,/0/default.jpg`;
  } else {
    previewImageUrl = isIIIFv3 ? preview.id : preview['@id'];
  }

  let supportsDownscale =
    images.find(
      (i) =>
        i.service?.profile?.some?.(p => p.supports?.indexOf('sizeByWh') >= 0) ||
        i.service?.profile?.endsWith?.('level2.json') ||
        i.service?.profile?.[0]?.endsWith?.('level2.json') ||
        i.service?.[0]?.profile === 'level2' ||
        i.service?.profile?.[0]?.endsWith?.('level2.json') ||
        i.service?.profile?.endsWith?.('level1.json') ||
        i.service?.[0]?.profile === 'level1'
    ) !== undefined;

    let imageApiHasCors: boolean;
    try {
      let testImgResp = await fetch(images[0]['@id']);
      let testImgData = new Uint8Array(await testImgResp.arrayBuffer());
      imageApiHasCors = testImgData[0] !== undefined;
    } catch {
      imageApiHasCors = false;
    }

  return {
    label: manifestJson.label,
    previewImageUrl,
    maximumImageWidth: max(images.map((i) => i.service?.width ?? 0)),
    manifestJson,
    supportsDownscale,
    imageApiHasCors,
  };
}
