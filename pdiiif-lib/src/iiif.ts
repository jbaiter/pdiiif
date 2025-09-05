import {
  InternationalString,
  ExternalWebResource,
  IIIFExternalWebResource,
  ContentResource,
  ImageProfile,
  ImageService,
  Reference,
  Creator,
  Agent,
  W3CAnnotationTarget,
} from '@iiif/presentation-3';
import {
  ManifestNormalized,
  CanvasNormalized,
  AnnotationPageNormalized,
  AnnotationNormalized,
} from '@iiif/presentation-3-normalized';
import {
  globalVault, Vault,
  buildLocaleString,
  createPaintingAnnotationsHelper,
  createThumbnailHelper,
  expandTarget,
  SupportedTarget,
} from '@iiif/helpers';
import { ImageServiceLoader as ImageServiceLoader_ } from '@atlas-viewer/iiif-image-api';

import { getOcrReferences } from './ocr.js';
import log from './log.js';
import { fetchRespectfully } from './download.js';

const PURPOSE_ORDER = ['commenting', 'describing', 'tagging', 'no-purpose'];
const PURPOSE_LABELS: { [purpose: string]: string } = {
  commenting: 'Comment',
  describing: 'Description',
  tagging: 'Tags',
};

export const vault = globalVault() as Vault;

/** Given a language preference in descending order,
 * determine the best set of strings from the
 * internationalized string.
 */
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

/** Custom image loader to deal with browser + node intercompatibility.
 *
 * Used for the thumbnail helper.
 */
class ImageServiceLoader extends ImageServiceLoader_ {
  async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    return fetchRespectfully(input as any, init as any) as any;
  }
}

const thumbHelper = createThumbnailHelper(vault, {
  imageServiceLoader: new ImageServiceLoader(),
});

// A few helpers to deal with painting annotations
export const { getPaintables, getAllPaintingAnnotations, extractChoices } =
  createPaintingAnnotationsHelper(vault);

/** Determine best thumbnail image for the manifest. */
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

/** Like a regular external web resource, but with an associated
 profile URI, needed for OCR discovery */
export interface ExternalWebResourceWithProfile extends ExternalWebResource {
  profile: string;
}

/** Check if a resource is an external resource with an
 * associated profile. */
export function isExternalWebResourceWithProfile(
  res: ContentResource
): res is ExternalWebResourceWithProfile {
  return (
    res.type !== undefined &&
    ['Dataset', 'Image', 'Video', 'Sound', 'Text', 'unknown'].indexOf(
      res.type
    ) >= 0 &&
    (res as ExternalWebResourceWithProfile).profile !== undefined
  );
}

/** See https://iiif.io/api/annex/services/#physical-dimensions */
export interface PhysicalDimensionService {
  '@context': 'http://iiif.io/api/annex/services/physdim/1/context.json';
  profile: 'http://iiif.io/api/annex/services/physdim';
  '@id': string;
  physicalScale: number;
  physicalUnits: 'in' | 'cm' | 'mm';
}

/** Check if a service is a IIIF Physical Dimensions service */
export function isPhysicalDimensionService(
  service: any // eslint-disable-line @typescript-eslint/explicit-module-boundary-types
): service is PhysicalDimensionService {
  return (
    typeof service.profile === 'string' &&
    service.profile === 'http://iiif.io/api/annex/services/physdim'
  );
}

/** Check if a IIIF Image endpoint supports arbitrary downscaling. */
export function supportsScaling(profile: ImageProfile): boolean {
  if (typeof profile === 'string') {
    return profile.indexOf('level2') >= 0;
  } else {
    return (profile.supports?.indexOf('sizeByWh') ?? -1) >= 0;
  }
}

export type ImageInfo = {
  // The 'Image' content resource
  resource: (ExternalWebResource | IIIFExternalWebResource) & { type: 'Image' };
  // Where to draw on the corresponding canvas
  x: number;
  y: number;
  // At what size to draw on the canvas?
  width: number;
  height: number;
  // What is the image's size, if available?
  nativeWidth?: number;
  nativeHeight?: number;
  ppi?: number;
  format?: 'jpeg' | 'png' | 'unsupported';
  choiceInfo?: {
    enabled: boolean;
    optional: boolean;
    visibleByDefault: boolean;
    label?: InternationalString;
  };
};

/** Information about a canvas that can be obtained without
 *  fetching any external resources */
export type CanvasInfo = {
  canvas: Reference<'Canvas'>;
  ocr?: {
    id: string;
  };
  images: ImageInfo[];
  numAnnotations: number;
};

/** Extract all non-painting annotations that are of interest for PDF generation
 * from a canvas */
export function getCanvasAnnotations(canvas: CanvasNormalized): Annotation[] {
  return vault
    .get<AnnotationPageNormalized>(canvas.annotations)
    .flatMap((p) => vault.get<AnnotationNormalized>(p.items))
    .filter((a) =>
      Array.isArray(a.motivation)
        ? a.motivation.find((m) => PURPOSE_LABELS[m] !== undefined) !==
          undefined
        : PURPOSE_LABELS[a.motivation ?? 'invalid'] !== undefined
    )
    .map((a) => parseAnnotation(a, []))
    .filter((a): a is Annotation => a !== undefined);
}

/** Obtain all information about a canvas and its images
 * without hitting any external endpoints.
 */
export function getCanvasInfo(canvas: CanvasNormalized): CanvasInfo {
  const imageInfos = getImageInfos(canvas);
  const text = getOcrReferences(canvas);
  return {
    canvas: { id: canvas.id, type: 'Canvas' },
    images: imageInfos,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    ocr: text ? { id: text.id! } : undefined,
    numAnnotations: getCanvasAnnotations(canvas).length,
  };
}

/** A annotation prepared for rendering to PDF. */
export interface Annotation {
  id: string;
  target: SupportedTarget;
  markup: string;
  lastModified?: Date;
  author?: string;
}

/** Format an annotation agent to a human readable string. */
function agentToString(agent: Agent): string {
  let name = Array.isArray(agent.name) ? agent.name.join('; ') : agent.name;
  if (!name) {
    name = agent.nickname ?? 'unknown';
  }
  if (agent.email) {
    return `${name} <${agent.email}>`;
  }
  return name;
}

/** Format a annotation creator definition to a human readable
 * string. */
function creatorToString(creator: Creator): string {
  if (Array.isArray(creator)) {
    if (typeof creator[0] === 'string') {
      return creator.join('; ');
    } else {
      return creator.map((a) => agentToString(a as Agent)).join('; ');
    }
  }
  if (typeof creator === 'string') {
    return creator;
  }
  return agentToString(creator);
}

/** Parse a IIIF annotation into a format that is more
 *  suitable for rendering to a PDF. */
export function parseAnnotation(
  anno: AnnotationNormalized,
  langPrefs: readonly string[]
): Annotation | undefined {
  if (!anno.target) {
    return;
  }
  // TODO: i18n?
  const annoBody = anno.body.map((bodyRef) =>
    vault.get<ContentResource>(bodyRef.id)
  );
  const creatorNames: Array<string> = annoBody
    .map((body) => body.creator)
    .filter((v: Creator | undefined): v is Creator => v !== undefined)
    .map(creatorToString);
  const modifiedDates: Array<number> = annoBody
    .map((body) => body.modified)
    .filter((v: string | undefined): v is string => v !== undefined)
    .map((v: string) => new Date(v).getTime());
  if (typeof anno.target === 'string') {
    return;
  }
  const targets = vault.get<Exclude<W3CAnnotationTarget, string>>(anno.target.map(t => t.id));
  const target = expandTarget(targets);
  const markup = buildAnnotationMarkup(annoBody);
  if (!markup) {
    // TODO: Log?
    throw `No valid textual content in annotation.`;
  }
  return {
    id: anno.id,
    target,
    markup,
    lastModified:
      modifiedDates.length > 0
        ? new Date(Math.max(...modifiedDates))
        : undefined,
    author: creatorNames.length > 0 ? creatorNames.join('; ') : undefined,
  };
}

/** Convert Annotation HTML to PDF Markup */
function buildAnnotationMarkup(
  bodies: Array<ContentResource>
): string | undefined {
  const parts: { [purpose: string]: Array<string> } = {};
  for (const body of bodies) {
    if (
      body.type !== 'TextualBody' ||
      (body.format !== 'text/plain' && body.format !== 'text/html') ||
      body.value === undefined
    ) {
      continue;
    }
    let { purpose } = body;
    if (Array.isArray(purpose)) {
      purpose = purpose[0];
    } else if (!purpose) {
      purpose = 'no-purpose';
    }
    if (!parts[purpose]) {
      parts[purpose] = [];
    }
    parts[purpose].push(body.value);
  }
  if (Object.keys(parts).length === 0) {
    return undefined;
  }
  const out: Array<string> = [];
  for (const purpose of PURPOSE_ORDER) {
    const purposeLabel = PURPOSE_LABELS[purpose];
    if (!parts[purpose]) {
      continue;
    }
    if (parts[purpose].length > 1) {
      if (purposeLabel) {
        out.push(`<p><b>${purposeLabel}:</b></p>`);
      }
      for (const part of parts[purpose]) {
        // TODO: Convert HTML to PDF rich text
        out.push(`<p>${part}</p>`);
      }
    } else {
      out.push('<p>');
      if (purposeLabel) {
        out.push(`<b>${purposeLabel}:</b> `);
      }
      out.push(`${parts[purpose][0]}</p>`);
    }
  }
  if (out.length === 0) {
    return undefined;
  }
  return out.join('\n');
}

export interface CompatibilityReport {
  compatibility: 'compatible' | 'incompatible' | 'degraded';
  incompatibleElements: {
    [canvasId: string]: Set<
      | 'no-jpeg' // At least one image doesn't have a JPEG representation
      | 'no-image' // Canvas does not have a single image annotation
      | 'annotations' // Canvas has non-painting annotations
      | 'unsupported-painting'
    >;
  };
}

export function checkCompatibility(
  manifest: ManifestNormalized
): CompatibilityReport | undefined {
  const report = {
    compatibility: 'compatible',
    incompatibleElements: {},
  };
  for (const canvas of vault.get<CanvasNormalized>(manifest.items)) {
    const paintingResources = vault
      .get<AnnotationPageNormalized>(canvas.items)
      .flatMap((ap) => vault.get<AnnotationNormalized>(ap.items))
      .flatMap((a) => vault.get<ContentResource>(a.body.map(b => b.id)));
    const nonPaintingAnnos = manifest.annotations;
    // TODO: Check if canvas has an image
    // TODO: Check if every painting annotation is an image with a JPEG available
    // TODO: Check for the presence of non-painting annotations
  }
  return undefined;
}

/** Parse a IIIF target specification */
export function parseTarget(targetStr: string): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const [canvasId, fragment] = targetStr.split('#xywh=');
  if (fragment) {
    const [x, y, width, height] = fragment
      .split(',')
      .map((x) => parseInt(x, 10));
    return { x, y, width, height };
  } else {
    const canvas = vault.get<CanvasNormalized>(canvasId);
    // Draw to fit canvas
    return { x: 0, y: 0, width: canvas.width, height: canvas.height };
  }
}

export function getImageFormat(
  image: ExternalWebResource | IIIFExternalWebResource
): 'jpeg' | 'png' | 'unsupported' | undefined {
  if (image.format === 'image/jpeg') {
    return 'jpeg';
  } else if (image.format === 'image/png') {
    return 'png';
  } else if (image.format === undefined) {
    if (image.id?.endsWith('.jpg') || image.id?.endsWith('.jpeg')) {
      return 'jpeg';
    } else if (image.id?.endsWith('.png')) {
      return 'png';
    }
  } else {
    return 'unsupported';
  }
}

/** Get information about images on a Canvas. */
export function getImageInfos(canvas: CanvasNormalized): ImageInfo[] {
  const imageInfos: ImageInfo[] = [];
  const paintingAnnos = vault.get<AnnotationPageNormalized>(canvas.items)
    .flatMap((ap) => vault.get<AnnotationNormalized>(ap.items));
  for (const anno of paintingAnnos) {
    const annoTarget = anno.target as any;
    let target;
    if (typeof annoTarget === 'string') {
      target = parseTarget(annoTarget);
    } else if (annoTarget.type === 'SpecificResource') {
      target = parseTarget(annoTarget.source.id);
    } else {
      console.error(`Unsupported target type for annotation on canvas ${canvas.id}: '${annoTarget.type}'`);
      continue;
    }


    const body = vault.get<ContentResource>(anno.body.map(b => b.id));
    for (const resource of body) {
      if (resource.type !== 'Image') {
        continue;
      }
      imageInfos.push({
        resource: resource as (
          | ExternalWebResource
          | IIIFExternalWebResource
        ) & { type: 'Image' },
        ...target,
        format: getImageFormat(resource),
        nativeWidth: (resource as any).width as number | undefined,
        nativeHeight: (resource as any).height as number | undefined,
      });
    }
  }

  const choice = extractChoices(paintingAnnos);
  if (choice?.type !== 'single-choice') {
    // Return early if there are no choices available
    return imageInfos;
  }

  for (const choiceItem of choice.items) {
    const resource = vault.get<ContentResource>(choiceItem.id);
    if (resource.type !== 'Image') {
      continue;
    }
    imageInfos.push({
      resource: resource as (ExternalWebResource | IIIFExternalWebResource) & {
        type: 'Image';
      },
      // FIXME: Can't choice images have a location and rendering dimensions?
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
      nativeWidth: (resource as any).width as number | undefined,
      nativeHeight: (resource as any).height as number | undefined,
      format: getImageFormat(resource),
      choiceInfo: {
        enabled: choiceItem.selected ?? false,
        optional: true,
        label: (resource as any).label,
        visibleByDefault: choiceItem.selected ?? false,
      },
    });
  }

  return imageInfos;
}
