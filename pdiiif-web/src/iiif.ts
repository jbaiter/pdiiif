import { max } from 'lodash-es';

import type {
  ManifestNormalized,
  CanvasNormalized,
  AnnotationPageNormalized,
  AnnotationNormalized,
  ContentResource,
  IIIFExternalWebResource,
} from '@iiif/presentation-3';
import { globalVault, Vault } from '@iiif/vault';
import { createThumbnailHelper, getValue } from '@iiif/vault-helpers';
import {
  supportsCustomSizes,
  getImageServices,
} from '@atlas-viewer/iiif-image-api';

const vault: Vault = globalVault();
const thumbHelper = createThumbnailHelper(vault);

export interface ManifestInfo {
  label: string;
  previewImageUrl?: string;
  manifest: ManifestNormalized;
  maximumImageWidth: number;
  supportsDownscale: boolean;
  imageApiHasCors: boolean;
  numPages: number;
}

// TODO: Use manifesto.js for i18n and better 2/3 cross-compatibility
export async function fetchManifestInfo(
  manifestUrl: string
): Promise<ManifestInfo> {
  const manifest = await vault.loadManifest(manifestUrl);
  const canvases = vault.get<CanvasNormalized>(manifest.items);
  const canvasIds = canvases.map((c) => c.id);
  const images = canvases
    .flatMap((c) => vault.get<AnnotationPageNormalized>(c.items))
    .flatMap((ap) => vault.get<AnnotationNormalized>(ap.items))
    .flatMap((a) => vault.get<ContentResource>(a.body))
    .filter(
      (r: ContentResource): r is IIIFExternalWebResource => r.type === 'Image'
    );
  const previewImageUrl = (
    await thumbHelper.getBestThumbnailAtSize(manifest, {
      maxWidth: 300,
      maxHeight: 300,
    })
  ).best.id;

  const supportsDownscale =
    images.flatMap(getImageServices).find(supportsCustomSizes) !== undefined;

  let imageApiHasCors: boolean;
  try {
    let testImgResp = await fetch(images[0]['@id'] ?? images[0].id);
    let testImgData = new Uint8Array(await testImgResp.arrayBuffer());
    imageApiHasCors = testImgData[0] !== undefined;
  } catch {
    imageApiHasCors = false;
  }

  const maximumImageWidth = max(images.map((i) => i.width ?? 0));

  return {
    label: getValue(manifest.label),
    previewImageUrl,
    maximumImageWidth,
    manifest,
    supportsDownscale,
    imageApiHasCors,
    numPages: canvasIds.length,
  };
}
