import path from 'path';
import { promises as fs } from 'fs';
import express, { Response } from 'express';
import fetch from 'node-fetch';
import {
  convertManifest,
  estimatePdfSize,
  ProgressStatus,
  version as serverVersion,
} from 'pdiiif';
import range from 'lodash/range';
import acceptLanguageParser from 'accept-language-parser';
import cors from 'cors';
import puppeteer from 'puppeteer';
import Handlebars from 'handlebars';
import QRCode from 'qrcode-svg';
import sanitizeHtml from 'sanitize-html';
import {
  middleware as openApiMiddleware,
  pdfPath as pdfPathSpec,
  progressPath as progressPathSpec,
  coverPath as coverPathSpec,
} from './openapi';
import sortBy from 'lodash/sortBy';
import { PropertyValue } from 'manifesto.js';

export interface CoverPageParams {
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
}

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

let coverPageTemplate: Handlebars.TemplateDelegate;
let browser: puppeteer.Browser;
const app = express();

async function setupGlobals(): Promise<void> {
  browser = await puppeteer.launch({ product: 'chrome', headless: true });
  const tmpl = await fs.readFile(
    path.join(__dirname, '..', 'assets', 'coverpage.hbs')
  );
  coverPageTemplate = Handlebars.compile(tmpl.toString('utf8'));
}

app.use(openApiMiddleware);
app.use(
  cors({
    origin: '*',
  })
);
app.use('/docs', openApiMiddleware.swaggerui);
app.use(express.json());

const progressClients: { [token: string]: Response } = {};

async function validateManifest(res: Response, manifestUrl: any): Promise<any> {
  const badManifestUrl =
    !manifestUrl ||
    typeof manifestUrl !== 'string' ||
    (!manifestUrl.startsWith('http://') && !manifestUrl.startsWith('https://'));
  if (badManifestUrl) {
    res
      .status(400)
      .json({
        reason:
          'manifestUrl parameter is mandatory and must be a single-valued valid URL',
      })
      .send();
    return;
  }
  const manifestResp = await fetch(manifestUrl as string);
  if (manifestResp.status != 200) {
    res
      .status(500)
      .json({
        reason: `Could not fetch manifest from ${manifestUrl}, got HTTP status ${manifestResp.status}`,
      })
      .send();
    return;
  }
  const manifestJson = await manifestResp.json();
  if (!manifestJson) {
    res
      .status(500)
      .json({
        reason: `Response from ${manifestUrl} did not contain valid IIIF Manifest.`,
      })
      .send();
    return;
  }
  return manifestJson;
}

function buildCanvasFilter(manifestJson: any, indexSpec: string): string[] {
  const canvasIdxs = new Set(
    indexSpec.split(',').reduce((idxs, grp) => {
      if (grp.indexOf('-') > 0) {
        const parts = grp.split('-');
        idxs.concat(
          range(Number.parseInt(parts[0]), Number.parseInt(parts[1]))
        );
      } else {
        idxs.push(Number.parseInt(grp));
      }
      return idxs;
    }, [])
  );
  return (manifestJson.items ?? manifestJson.sequences?.[0]?.canvases)
    .map((c) => (c.id ?? c['@id']) as string)
    .filter((_, idx) => canvasIdxs.has(idx));
}

async function renderCoverPage(params: CoverPageParams): Promise<Buffer> {
  let thumbUrl = params.thumbnail?.url;
  if (params.thumbnail?.iiifImageService) {
    // Preview image is 1.8in wide, at 300dpi
    const desiredWidthPx = 1.8 * 300;
    const baseUrl = params.thumbnail?.iiifImageService;
    const infoResp = await fetch(`${baseUrl}/info.json`);
    const infoJson = await infoResp.json();
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
  const page = await browser.newPage();
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
  const html = coverPageTemplate(templateParams);
  await page.setContent(html, { waitUntil: 'load' });
  return page.pdf();
}

app.get('/api/progress/:token', progressPathSpec, (req, res) => {
  const { token } = req.params;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache',
  });
  res.flushHeaders();
  progressClients[token] = res;

  req.on('close', () => {
    delete progressClients[token];
  });
});

app.get('/api/estimate-size', async (req, res) => {
  const {
    manifestUrl,
    canvasNos,
    preferLossless = 'false',
    maxWidth,
  } = req.query;
  const manifestJson = await validateManifest(res, manifestUrl);
  if (!manifestJson) {
    return;
  }
  let canvasIds: string[] | undefined;
  if (canvasNos && typeof canvasNos === 'string') {
    canvasIds = buildCanvasFilter(manifestJson, canvasNos);
  }
  const estimatedSize = await estimatePdfSize({
    manifestJson,
    concurrency: 4,
    numSamples: 4,
    filterCanvases: canvasIds,
    maxWidth: maxWidth ? Number.parseInt(maxWidth as string) : undefined,
    preferLossless: preferLossless !== undefined,
  });
  res.json({
    estimatedSize,
  });
});

app.get(
  '/api/generate-pdf',
  pdfPathSpec,
  async (req, res) => {
    const { manifestUrl, canvasNos, locale, progressToken } = req.query;
    const manifestJson = await validateManifest(res, manifestUrl);
    if (!manifestJson) {
      return;
    }

    // Get client's locale preferences
    let languagePreference: string[] = [];
    if (locale && typeof locale === 'string') {
      // Explicit locale override from user
      languagePreference = [locale];
    } else if (req.header('accept-language')) {
      // Accept-Language header
      languagePreference = acceptLanguageParser
        .parse(req.header('accept-language')[0])
        .map((l) => (l.region ? `${l.code}-${l.region}` : l.code));
    }
    const cleanLabel = PropertyValue.parse(manifestJson.label)
      .getValue(languagePreference)
      ?.substring(0, 200); // Limit file name length

    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Transfer-Encoding': 'chunked',
      'Content-Disposition': `attachment; filename="${cleanLabel}.pdf"`,
    });

    // Get optional canvas identifiers to filter by
    let canvasIds: string[] | undefined;
    if (canvasNos && typeof canvasNos === 'string') {
      canvasIds = buildCanvasFilter(manifestJson, canvasNos);
    }

    // Register the progress tracker
    let onProgress: (status: ProgressStatus) => void | undefined;
    if (progressToken && typeof progressToken === 'string') {
      res.socket.on('close', () => {
        const clientResp = progressClients[progressToken];
        if (!clientResp) {
          return;
        }
        clientResp.write('event: cancel\n');
        progressClients[progressToken]?.end(
          undefined,
          () => delete progressClients[progressToken]
        );
      });
      onProgress = (progressStatus) => {
        const clientResp = progressClients[progressToken];
        if (clientResp) {
          clientResp.write('event: progress\n');
          clientResp.write(`data: ${JSON.stringify(progressStatus)}\n\n`);
        }
      };
    }

    await convertManifest(manifestJson, res, {
      languagePreference,
      filterCanvases: canvasIds,
      onProgress,
      coverPageCallback: async (params) => {
        const buf = await renderCoverPage(params);
        await fs.writeFile('/tmp/coverpage.pdf', buf);
        return new Uint8Array(buf.buffer);
      },
    });
    if (progressToken && typeof progressToken === 'string') {
      progressClients[progressToken]?.end(
        undefined,
        () => delete progressClients[progressToken]
      );
    }
    res.end();
  },
  (err, _req, res, _next) => {
    res.status(err.status).json({
      error: err.message,
      validation: err.validationErrors,
    });
  }
);

app.post(
  '/api/coverpage',
  coverPathSpec,
  async (req, res) => {
    // Need to destructure to prevent XSS
    const {
      title,
      provider,
      requiredStatement,
      rights,
      thumbnail,
      metadata,
      manifestUrl,
    } = req.body as CoverPageParams;
    const pdfBuf = await renderCoverPage({
      title,
      manifestUrl,
      metadata,
      provider,
      requiredStatement,
      rights,
      thumbnail,
    });
    res
      .status(200)
      .contentType('application/pdf')
      .header('Access-Control-Allow-Origin: *')
      .send(pdfBuf);
  },
  (err, _req, res, _next) => {
    console.log(err);
    res.status(err.status).json({
      error: err.message,
      validation: err.validationErrors,
    });
  }
);

setupGlobals().then(() =>
  app.listen(31337, () => {
    console.log('server started at http://localhost:31337');
  })
);

// FIXME: There surely must be a better way to handle connections that are
//        terminated by the peer?
process.on('uncaughtException', function (err: Error) {
  const errCode = (err as any).code;
  switch (errCode) {
    case 'EPIPE':
    case 'ECONNRESET':
      // Happens when cliens terminate their download, ignore
      return;
    default:
      throw err;
  }
});
process.on('exit', async () => {
  await browser.close();
});
