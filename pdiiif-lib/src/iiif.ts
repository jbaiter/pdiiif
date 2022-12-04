import fetch from 'cross-fetch';
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
  Creator,
  Agent,
} from '@iiif/presentation-3';
import {
  buildLocaleString,
  createPaintingAnnotationsHelper,
  createThumbnailHelper,
  expandTarget,
  SingleChoice,
  SupportedTarget,
  Paintables,
  ChoiceDescription,
} from '@iiif/vault-helpers';
import { ImageServiceLoader as ImageServiceLoader_ } from '@atlas-viewer/iiif-image-api';
import { globalVault, Vault } from '@iiif/vault';
import { getTextSeeAlso } from './ocr.js';

const PURPOSE_ORDER = ['commenting', 'describing', 'tagging', 'no-purpose'];
const PURPOSE_LABELS: { [purpose: string]: string } = {
  commenting: 'Comment',
  describing: 'Description',
  tagging: 'Tags',
};

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


class ImageServiceLoader extends ImageServiceLoader_ {
  async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    return fetch(input as any, init as any) as any;
  }
}

// FIXME: Remove type hints once vault-helpers has had a release
const thumbHelper = createThumbnailHelper(vault, {
  imageServiceLoader: new ImageServiceLoader(),
});
export const { getPaintables, getAllPaintingAnnotations, extractChoices } =
  createPaintingAnnotationsHelper(vault) as {
    getAllPaintingAnnotations: (
      canvasOrId: string | CanvasNormalized | undefined | null
    ) => AnnotationNormalized[];
    getPaintables: (
      paintingAnnotationsOrCanvas:
        | string
        | CanvasNormalized
        | AnnotationNormalized[],
      enabledChoices?: string[]
    ) => Paintables;
    extractChoices: (
      paintingAnnotationsOrCanvas:
        | string
        | CanvasNormalized
        | AnnotationNormalized[]
    ) => ChoiceDescription | null;
  };

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
    ['Dataset', 'Image', 'Video', 'Sound', 'Text', 'unknown'].indexOf(
      res.type
    ) >= 0 &&
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

type CanvasInfoImage = {
  img: Reference<'ContentResource'>;
  choiceState?: { enabled?: true };
  label?: InternationalString;
};

export type CanvasInfo = {
  canvas: Reference<'Canvas'>;
  ocr?: {
    id: string;
  };
  images: CanvasInfoImage[];
  numAnnotations: number;
};

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

export function getCanvasInfo(canvas: CanvasNormalized): CanvasInfo {
  const paintables = getPaintables(canvas);
  // FIXME: complex choices are currently untested
  const choiceImageIds =
    paintables.choice?.items
      ?.flatMap((i) => {
        if ('items' in i) {
          return i.items;
        } else {
          return [i];
        }
      })
      .map((i) => i.id) ?? [];
  const images: Array<CanvasInfoImage> = paintables.items
    .filter((p) => p.type === 'image')
    .filter(
      (p) =>
        p.resource.id !== undefined &&
        choiceImageIds?.indexOf(p.resource.id) < 0
    )
    .map((i) => ({
      img: {
        id: i.resource.id,
        type: 'ContentResource',
      } as Reference<'ContentResource'>,
      isOptional: false,
    }));
  // TODO: Add support for complex choices?
  if (paintables.choice?.type === 'single-choice') {
    const choice = paintables.choice as SingleChoice;
    for (const itm of choice.items) {
      const res = vault.get<ContentResource>(itm.id);
      if (res.type !== 'Image') {
        continue;
      }
      images.push({
        img: { id: itm.id, type: 'ContentResource' },
        choiceState: { enabled: itm.selected },
        label: itm.label,
      });
    }
  }
  const text = getTextSeeAlso(canvas);
  return {
    canvas: { id: canvas.id, type: 'Canvas' },
    images,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    ocr: text ? { id: text.id! } : undefined,
    numAnnotations: getCanvasAnnotations(canvas).length,
  };
}

export interface Annotation {
  id: string;
  target: SupportedTarget;
  markup: string;
  lastModified?: Date;
  author?: string;
}

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

export function parseAnnotation(
  anno: AnnotationNormalized,
  langPrefs: readonly string[]
): Annotation | undefined {
  if (!anno.target) {
    return;
  }
  const annoBody = anno.body.map((bodyRef) =>
    vault.get<ContentResource>(bodyRef)
  );
  const creatorNames: Array<string> = annoBody
    .map((body) => body.creator)
    .filter((v: Creator | undefined): v is Creator => v !== undefined)
    .map(creatorToString);
  const modifiedDates: Array<number> = annoBody
    .map((body) => body.modified)
    .filter((v: string | undefined): v is string => v !== undefined)
    .map((v: string) => new Date(v).getTime());
  const target = expandTarget(anno.target);
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
      .flatMap((a) => vault.get<ContentResource>(a.body));
    const nonPaintingAnnos = manifest.annotations;
    // TODO: Check if canvas has an image
    // TODO: Check if every painting annotation is an image with a JPEG available
    // TODO: Check for the presence of non-painting annotations
  }
  return undefined;
}
