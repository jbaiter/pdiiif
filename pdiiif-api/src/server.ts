import fs from 'fs';
import https from 'https';
import express, { Express, Response } from 'express';
import fetch from 'node-fetch';
import { range, maxBy } from 'lodash';
import acceptLanguageParser from 'accept-language-parser';
import cors from 'cors';
import promBundle from 'express-prom-bundle';
import * as Sentry from '@sentry/node';
import * as Tracing from '@sentry/tracing';
import {
  AnnotationNormalized,
  AnnotationPageNormalized,
  CanvasNormalized,
  ContentResource,
  ManifestNormalized,
} from '@iiif/presentation-3';
import { globalVault, Vault } from '@iiif/vault';
import { buildLocaleString } from '@iiif/vault-helpers';

import {
  middleware as openApiMiddleware,
  pdfPath as pdfPathSpec,
  progressPath as progressPathSpec,
  coverPath as coverPathSpec,
} from './openapi';
import { convertManifest, ProgressStatus } from 'pdiiif';
import log from './logger';
import { CoverPageGenerator, CoverPageParams } from './coverpage';
import { RateLimiter } from './limit';
import { GeneratorQueue } from './queue';

const vault: Vault = globalVault();

async function validateManifest(res: Response, manifestUrl: any): Promise<any> {
  const badManifestUrl =
    !manifestUrl ||
    typeof manifestUrl !== 'string' ||
    (!manifestUrl.startsWith('http://') && !manifestUrl.startsWith('https://'));
  if (badManifestUrl) {
    log.info('Received illegal URL, rejected request.', { manifestUrl });
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
    log.info('Could not receive manifest, failed to serve request.', {
      manifestUrl,
      httpStatus: manifestResp.status,
    });
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
    log.info(
      'Manifest response did not include JSON data, failed to serve request.',
      { manifestUrl }
    );
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

function buildCanvasFilter(
  manifest: ManifestNormalized,
  indexSpec: string
): string[] {
  const canvasIdxs = new Set(
    indexSpec
      .split(',')
      .filter((g) => g.length > 0)
      .reduce((idxs: number[], grp: string) => {
        if (grp.indexOf('-') > 0) {
          const parts = grp.split('-');
          idxs = idxs.concat(range(Number.parseInt(parts[0]), Number.parseInt(parts[1])));
        } else {
          idxs.push(Number.parseInt(grp));
        }
        return idxs;
      }, [])
  );
  return manifest.items
    .map((c) => c.id)
    .filter((_, idx) => canvasIdxs.has(idx));
}

// Used to generate cover page PDFs with a Chromium instance that runs in the background
const coverPageGenerator = new CoverPageGenerator(
  process.env.CFG_COVERPAGE_TEMPLATE
);
// Tracks rate limiting data for clients
const rateLimiter = new RateLimiter({
  defaults: {
    cover: {
      rate: Number.parseInt(process.env.CFG_RATELIMIT_COVER ?? '3000', 10),
      burst: Number.parseInt(process.env.CFG_RATEIMIT_COVER_BURST ?? '50', 10),
      period: 24 * 60 * 60 * 1000,
    },
    pdf: {
      rate: Number.parseInt(process.env.CFG_RATELIMIT_PDF ?? '3000', 10),
      burst: Number.parseInt(process.env.CFG_RATEIMIT_PDF_BURST ?? '50', 10),
      period: 24 * 60 * 60 * 1000,
    },
  },
  // TODO: Find a way to let users pass rate limiting exceptions
  exceptions: [],
});
// Tracks open progress reporting responses
const progressClients: { [token: string]: Response } = {};
// Controls concurrent fetching from Image API hosts to prevent accidental DoS
const globalConvertQueue = new GeneratorQueue(2);

const app: Express = express();
app.use(express.static('node_modules/pdiiif-web/dist'));
app.use(openApiMiddleware);
app.use(
  cors({
    origin: '*',
  })
);

app.use('/docs', openApiMiddleware.swaggerui);
app.use(express.json());

// Only allow access to Prometheus metrics endpoint from localhost
app.use('/metrics', (req, res, next) => {
  if (req.ip === '127.0.0.1') {
    next();
  } else {
    res.status(403).send();
  }
});
app.use(
  promBundle({
    includePath: true,
    normalizePath: [
      ['^/api/progress/.*', '/api/progress/#token'],
      ['^/api/generate-pdf.*', '/api/generate-pdf'],
      ['^/api/coverpage.*', '/api/coverpage'],
    ],
    promClient: {
      collectDefaultMetrics: {},
    },
    buckets: [0.05, 0.1, 0.5, 1, 1.5, 5, 10, 30, 60, 180, 300, 600],
  })
);

if (process.env.CFG_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.CFG_SENTRY_DSN,
    integrations: [
      new Sentry.Integrations.Http({ tracing: true }),
      new Tracing.Integrations.Express({ app }),
    ],
    tracesSampleRate: 1.0,
  });
  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.tracingHandler());
}

app.get('/api/progress/:token', progressPathSpec, (req, res) => {
  const { token } = req.params;
  if (progressClients[token] !== undefined) {
    res.status(423).send();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache',
  });
  const keepAliveTimer = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 15000);
  res.flushHeaders();
  progressClients[token] = res;

  req.on('close', () => {
    clearInterval(keepAliveTimer);
    delete progressClients[token];
  });
});

app.get(
  '/api/generate-pdf',
  pdfPathSpec,
  async (req, res) => {
    if (!res.socket) {
      return;
    }
    const shouldThrottle = rateLimiter.throttle(req.ip, 'pdf', res);
    if (shouldThrottle) {
      return;
    }
    const { manifestUrl, canvasNos, locale, progressToken, scaleFactor, ppi } =
      req.query;

    log.info('Generating PDF for manifest', {
      manifestUrl,
      canvasNos,
      locale,
      progressToken,
      scaleFactor,
      ppi,
    });

    const manifestJson = await validateManifest(res, manifestUrl);
    if (!manifestJson) {
      return;
    }
    const manifest = await vault.loadManifest(
      manifestJson.id ?? manifestJson['@id'],
      manifestJson
    );

    if (!manifest) {
      res.status(500).send();
      return;
    }

    // Get client's locale preferences
    let languagePreference: string[] = [];
    const acceptLangHeader = req.header('accept-language');
    if (locale && typeof locale === 'string') {
      // Explicit locale override from user
      languagePreference = [locale];
    } else if (acceptLangHeader) {
      // Accept-Language header
      languagePreference = acceptLanguageParser
        .parse(acceptLangHeader)
        .map((l) => (l.region ? `${l.code}-${l.region}` : l.code));
    } else {
      languagePreference = ['none'];
    }
    const cleanLabel = buildLocaleString(
      manifest.label,
      languagePreference[0],
      { closest: true, fallbackLanguages: languagePreference.slice(1) }
    )?.substring(0, 200); // Limit file name length

    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Transfer-Encoding': 'chunked',
      'Content-Disposition': `attachment; filename="${cleanLabel}.pdf"`,
    });

    // Get optional canvas identifiers to filter by
    let canvasIds: string[] | undefined;
    if (canvasNos && typeof canvasNos === 'string') {
      canvasIds = buildCanvasFilter(manifest, canvasNos);
    }

    // Get the primary image api host for queueing later on
    const imageHosts: { [hostname: string]: number } = vault
      .get<CanvasNormalized>(manifest.items)
      .flatMap((c) => vault.get<AnnotationPageNormalized>(c.items))
      .flatMap((ap) => vault.get<AnnotationNormalized>(ap.items))
      .flatMap((a) => vault.get<ContentResource>(a.body))
      .map(r => r.id)
      .filter((i: string | undefined): i is string => i !== undefined)
      // We'll just assume that the identifier of the content resource
      // has the same hostname as the IIIF service
      .map(i => new URL(i).hostname)
      .reduce((counts: {[hostname: string]: number }, hostname) => {
        counts[hostname] = (counts[hostname] ?? 0) + 1;
        return counts;
      }, {});
    const primaryImageHost = maxBy(
      Object.entries(imageHosts),
      ([, count]) => count
    )?.[0];

    if (!primaryImageHost) {
      res.status(500).send();
    }

    // Register the progress tracker
    let onQueueAdvance: (pos: number) => void | undefined = () => { return };
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
      onQueueAdvance = (pos) => {
        const clientResp = progressClients[progressToken];
        if (clientResp) {
          clientResp.write('event: queue\n');
          clientResp.write(`data: ${JSON.stringify({ position: pos })}\n\n`);
        }
      };
    }
    let abortController: AbortController | undefined = new AbortController();
    res.addListener('close', () => {
      if (abortController) {
        log.info('Connection closed prematurely, aborting conversion.');
        abortController.abort();
      }
    });

    const convertPromise = globalConvertQueue.add(
      () =>
        convertManifest(manifest.id, res, {
          languagePreference,
          filterCanvases: canvasIds,
          scaleFactor:
            scaleFactor === undefined
              ? undefined
              : Number.parseFloat(scaleFactor as string),
          ppi: ppi === undefined ? undefined : Number.parseInt(ppi as string),
          onProgress,
          coverPageCallback: async (params) => {
            const buf = await coverPageGenerator.render(params);
            return new Uint8Array(buf.buffer);
          },
          // Reduce chance of accidental DoS on image servers, two concurrent downloads per requested PDF
          concurrency: 2,
          abortController,
        }),
      primaryImageHost as string,
      onQueueAdvance
    );
    try {
      await convertPromise;
    } catch (err) {
      log.error(log.exceptions.getAllInfo(err as string | Error));
      if (progressToken && typeof progressToken === 'string') {
        const clientResp = progressClients[progressToken];
        if (clientResp) {
          clientResp.write('event: servererror\n');
          clientResp.write(`data: ${err}\n\n`);
        }
      }
    }
    abortController = undefined;
    if (progressToken && typeof progressToken === 'string') {
      progressClients[progressToken]?.end(
        undefined,
        () => delete progressClients[progressToken]
      );
    }
    res.end();
  },
  (err: any, _req: any, res: any) => {
    log.info('Rejected PDF request due to validation errors:', {
      message: err.message,
      details: err.validationErrors,
    });
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
    const shouldThrottle = rateLimiter.throttle(req.ip, 'cover', res);
    if (shouldThrottle) {
      return;
    }
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

    log.info('Generating cover page PDF for manifest', { manifestUrl });
    const pdfBuf = await coverPageGenerator.render({
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
    log.info('Rejected cover page request due to validation errors:', {
      message: err.message,
      details: err.validationErrors,
    });
    res.status(err.status).json({
      error: err.message,
      validation: err.validationErrors,
    });
  }
);

if (process.env.CFG_SENTRY_DSN) {
  // The error handler must be before any other error middleware and after all controllers
  app.use(Sentry.Handlers.errorHandler());
}

coverPageGenerator.start().then(() => {
  const port = Number.parseInt(process.env.CFG_PORT ?? '31337', 10);
  const host = process.env.CFG_HOST ?? '127.0.0.1';
  const sslCertPatht = process.env.CFG_SSL_CERT;
  const sslKey = process.env.CFG_SSL_KEY;
  if (sslCertPatht && sslKey) {
    const server = https.createServer(
      {
        key: fs.readFileSync(sslKey, 'utf8'),
        cert: fs.readFileSync(sslCertPatht, 'utf8'),
      },
      app
    );
    server.listen(port, host, () =>
      log.info(`server started at https://${host}:${port}`)
    );
  } else {
    app.listen(port, host, () => {
      log.info(`server started at http://${host}:${port}`);
    });
  }
});

process.on('unhandledRejection', function (err: Error) {
  if (
    (err as any).type === 'aborted' ||
    (err as any).code == 'ERR_STREAM_DESTROYED'
  ) {
    // FIXME: Where do these unhandled promise rejections come from?
    return;
  }
  log.error(err);
});

// Terminate cover page generator before exiting, closes the underlying
// Chromium instance
process.on('exit', async () => {
  await coverPageGenerator.shutdown();
});
