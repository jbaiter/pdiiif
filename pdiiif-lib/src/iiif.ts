import {
  InternationalString,
  ManifestNormalized,
  ExternalWebResource,
  ContentResource,
  ImageProfile,
  ImageService,
  CanvasNormalized,
  Reference,
  AnnotationPageNormalized,
  AnnotationNormalized,
} from '@iiif/presentation-3';
import { buildLocaleString, createThumbnailHelper } from '@iiif/vault-helpers';
import { globalVault, Vault } from '@iiif/vault';

export const vault = globalVault() as Vault;

export function getI18nValue(
  val: string | InternationalString,
  languagePreference: readonly string[]
): string[];
export function getI18nValue(
  val: string | InternationalString,
  languagePreference: readonly string[],
  separator: string
): string;
export function getI18nValue(
  val: string | InternationalString,
  languagePreference: readonly string[],
  separator?: string
): string | string[] {
  let splitAfter = false;
  if (!separator) {
    separator = '<<<SNIP>>>';
    splitAfter = true;
  }
  const localized = buildLocaleString(val, languagePreference[0] ?? 'none', {
    defaultText: '',
    fallbackLanguages: languagePreference.slice(1),
    separator,
  });
  if (splitAfter) {
    return localized.split(separator).filter((s) => s.length > 0);
  } else {
    return localized;
  }
}

const thumbHelper = createThumbnailHelper(vault);

export async function getThumbnail(
  manifest: ManifestNormalized,
  maxDimension: number
): Promise<string | undefined> {
  const thumb = await thumbHelper.getBestThumbnailAtSize(manifest, {
    maxWidth: maxDimension,
    maxHeight: maxDimension,
  });
  return thumb.best?.id;
}

export interface ExternalWebResourceWithProfile extends ExternalWebResource {
  profile: string;
}

export function isExternalWebResourceWithProfile(
  res: ContentResource
): res is ExternalWebResourceWithProfile {
  return (
    res.type !== undefined &&
    ['Dataset', 'Image', 'Video', 'Sound', 'Text', 'unknown'].indexOf(res.type) >= 0 &&
    (res as ExternalWebResourceWithProfile).profile !== undefined
  );
}

export interface PhysicalDimensionService {
  '@context': 'http://iiif.io/api/annex/services/physdim/1/context.json';
  profile: 'http://iiif.io/api/annex/services/physdim';
  '@id': string;
  physicalScale: number;
  physicalUnits: 'in' | 'cm' | 'mm';
}

export function isPhysicalDimensionService(
  service: any // eslint-disable-line @typescript-eslint/explicit-module-boundary-types
): service is PhysicalDimensionService {
  return (
    typeof service.profile === 'string' &&
    service.profile === 'http://iiif.io/api/annex/services/physdim'
  );
}

export function supportsScaling(profile: ImageProfile): boolean {
  if (typeof profile === 'string') {
    return profile.indexOf('level2') >= 0;
  } else {
    return (profile.supports?.indexOf('sizeByWh') ?? -1) >= 0;
  }
}

export async function fetchFullImageService(
  serviceRef: ImageService
): Promise<ImageService> {
  const serviceUrl = `${serviceRef['@id'] ?? serviceRef.id}/info.json`;
  const resp = await fetch(serviceUrl);
  const res = await resp.json();
  return res as ImageService;
}

export function getCanvasImages(canvases: CanvasNormalized[]): {
  canvas: Reference<'Canvas'>;
  images: Reference<'ContentResource'>[];
}[] {
  return canvases.map((c) => {
    const annos = vault
      .get<AnnotationPageNormalized>(c.items)
      .flatMap((p) => vault.get<AnnotationNormalized>(p.items));
    return {
      canvas: { id: c.id, type: 'Canvas' },
      images: annos.flatMap((a) => a.body),
    };
  });
}