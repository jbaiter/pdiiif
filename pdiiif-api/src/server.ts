import express, { Response } from 'express';
import fetch from 'node-fetch';
import range from 'lodash/range';
import acceptLanguageParser from 'accept-language-parser';
import cors from 'cors';
import promBundle from 'express-prom-bundle';
import { PropertyValue } from 'manifesto.js';

import {
  middleware as openApiMiddleware,
  pdfPath as pdfPathSpec,
  progressPath as progressPathSpec,
  coverPath as coverPathSpec,
} from './openapi';
import { convertManifest, ProgressStatus } from 'pdiiif';
import log from './logger';
import { CoverPageGenerator, CoverPageParams } from './coverpage';
import { RateLimiter } from './ratelimit';

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

function buildCanvasFilter(manifestJson: any, indexSpec: string): string[] {
  const canvasIdxs = new Set(
    indexSpec
      .split(',')
      .filter((g) => g.length > 0)
      .reduce((idxs, grp) => {
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

// Used to generate cover page PDFs with a Chromium instance that runs in the background
const coverPageGenerator = new CoverPageGenerator(
  process.env.CFG_COVERPAGE_TEMPLATE
);
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

const app = express();
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
    promClient: {
      collectDefaultMetrics: {},
    },
  })
);

// TODO: Define some custom Prometheus metrics

app.get('/api/progress/:token', progressPathSpec, (req, res) => {
  const { token } = req.params;
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

    try {
      await convertManifest(manifestJson, res, {
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
      });
    } catch (err) {
      log.error(log.exceptions.getAllInfo(err));
      if (progressToken && typeof progressToken === 'string') {
        const clientResp = progressClients[progressToken];
        if (clientResp) {
          clientResp.write('event: servererror\n');
          clientResp.write(`data: ${err}\n\n`);
        }
      }
    }
    if (progressToken && typeof progressToken === 'string') {
      progressClients[progressToken]?.end(
        undefined,
        () => delete progressClients[progressToken]
      );
    }
    res.end();
  },
  (err, _req, res, _next) => {
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

coverPageGenerator.start().then(() => {
  const port = Number.parseInt(process.env.CFG_PORT ?? '31337', 10);
  const host = process.env.CFG_HOST ?? '127.0.0.1';
  app.listen(port, host, () =>
    log.info(`server started at http://${host}:${port}`)
  );
});

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
      log.error('Uncaught exception', { error: err });
      throw err;
  }
});

// Terminate cover page generator before exiting, closes the underlying
// Chromium instance
process.on('exit', async () => {
  await coverPageGenerator.shutdown();
});
