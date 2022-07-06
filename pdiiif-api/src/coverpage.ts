import path from 'path';
import { PathLike, promises as fs } from 'fs';

import fetch from 'node-fetch';
import { AbortSignal } from 'node-fetch/externals';
import puppeteer from 'puppeteer';
import Handlebars from 'handlebars';
import QRCode from 'qrcode-svg';
import sanitizeHtml from 'sanitize-html';
import { sortBy } from 'lodash';

import { version as serverVersion } from 'pdiiif';
import metrics from './metrics';

Handlebars.registerHelper('qrcode', function (value, options) {
  const {
    width = 128,
    height = 128,
    padding = 0,
    color = '#000000',
    background = '#ffffff',
    ecl = 'L',
  } = options.hash;
  const qr = new QRCode({
    content: value,
    width,
    height,
    padding,
    color,
    background,
    ecl,
  });
  return qr.svg();
});
Handlebars.registerHelper('ifArray', function (potentialArray, options) {
  if (Array.isArray(potentialArray)) {
    return options.fn(this);
  } else {
    return options.inverse(this);
  }
});
Handlebars.registerHelper('sanitizeHtml', function (value) {
  return new Handlebars.SafeString(
    sanitizeHtml(value, {
      allowedTags: [
        'a',
        'b',
        'br',
        'i',
        'img',
        'p',
        'small',
        'span',
        'sub',
        'sup',
      ],
      allowedAttributes: {
        a: ['href'],
        img: ['src', 'alt'],
      },
    })
  );
});

export type CoverPageParams = {
  title: string;
  manifestUrl: string;
  thumbnail?: {
    url: string;
    iiifImageService?: string;
  };
  provider?: {
    label: string;
    homepage?: string;
    logo?: string;
  };
  requiredStatement?: {
    label: string;
    value: string;
  };
  rights?: {
    text: string;
    url?: string;
    logo?: string;
  };
  metadata?: Array<[string, string | Array<string>]>;
  pdiiifVersion?: string;
  abortSignal?: AbortSignal;
};

export class CoverPageGenerator {
  private coverTemplatePath: PathLike;
  private coverPageTemplate: Handlebars.TemplateDelegate;
  private browser?: puppeteer.Browser;

  constructor(
    coverTemplatePath: PathLike = path.join(
      __dirname,
      '..',
      'assets',
      'coverpage.hbs'
    )
  ) {
    this.coverTemplatePath = coverTemplatePath;
  }

  async start(): Promise<void> {
    this.browser = await puppeteer.launch({
      product: 'chrome',
      headless: true,
      args: ['--font-render-hinting=none', '--force-color-profile=srgb'],
      executablePath: process.env.CFG_PUPPETEER_BROWSER_EXECUTABLE
    });
    const tmpl = await fs.readFile(this.coverTemplatePath);
    this.coverPageTemplate = Handlebars.compile(tmpl.toString('utf8'));
  }

  async shutdown(): Promise<void> {
    await this.browser.close();
    this.browser = null;
  }

  async render(params: CoverPageParams): Promise<Buffer> {
    if (this.browser == null) {
      throw 'CoverPageGenerator must be started before it can render cover pages.';
    }
    if (params.abortSignal?.aborted) {
      throw 'aborted';
    }
    let thumbUrl = params.thumbnail?.url;
    if (params.thumbnail?.iiifImageService) {
      // Preview image is 1.8in wide, at 300dpi
      const desiredWidthPx = 1.8 * 300;
      const baseUrl = params.thumbnail?.iiifImageService;
      const stopMeasuring = metrics.coverPageInfoDuration.startTimer({ iiif_host: new URL(baseUrl).host });
      let infoJson;
      try {
        const infoResp = await fetch(`${baseUrl}/info.json`, { signal: params.abortSignal });
        infoJson = await infoResp.json();
        stopMeasuring({ status: 'success' });
      } catch (err) {
        stopMeasuring({ status: 'error' });
        throw err;
      }
      // Start out with the full width, just to be safe
      const maxWidth = infoJson.maxWidth ?? infoJson.width;
      let size = infoJson.type === 'ImageService3' ? 'max' : 'full';
      if (
        (desiredWidthPx < maxWidth && infoJson.profile === 'level1') ||
        infoJson.profile === 'level2' ||
        !infoJson.profile[0].endsWith('level0.json')
      ) {
        // Image API allows downscaling
        size = `${desiredWidthPx},`;
      } else if (infoJson.sizes?.length) {
        const closestSize = sortBy(
          infoJson.sizes,
          (size) => desiredWidthPx - size.width
        ).filter((size) => desiredWidthPx <= size.width)[0];
        size = `${closestSize.width},${closestSize.height}`;
      }
      thumbUrl = `${baseUrl}/full/${size}/0/default.jpg`;
    }
    const stopMeasuring = metrics.coverPageRenderDuration.startTimer();
    if (params.abortSignal?.aborted) {
      throw 'aborted';
    }
    try {
      const page = await this.browser.newPage();
      const templateParams = {
        thumbUrl,
        title: params.title,
        providerLogo: params.provider?.logo,
        providerText: params.provider?.label,
        providerLink: params.provider?.homepage,
        rightsLogo: params.rights?.logo,
        rightsText: params.rights?.text ?? params.rights?.url,
        rightsLink: params.rights?.url,
        requiredStatement: params.requiredStatement,
        metadata: params.metadata,
        manifestUrl: params.manifestUrl,
        pdiiifVersion: params.pdiiifVersion ?? serverVersion,
      };
      const html = this.coverPageTemplate(templateParams);
      if (params.abortSignal?.aborted) {
        throw 'aborted';
      }
      await page.setContent(html, { waitUntil: 'load', timeout: 30 * 1000 });
      if (params.abortSignal?.aborted) {
        throw 'aborted';
      }
      const pdf = await page.pdf();
      if (params.abortSignal?.aborted) {
        throw 'aborted';
      }
      await page.close();
      stopMeasuring({ status: 'success' });
      return pdf;
    } catch (err) {
      stopMeasuring({ status: 'error' });
      throw err;
    }
  }
}
