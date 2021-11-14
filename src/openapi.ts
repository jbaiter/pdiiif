import openapi from '@wesleytodd/openapi';

export const middleware = openapi({
  openapi: '3.0.0',
  info: {
    title: 'pdiiif API server',
    description: 'Provides an API for generating PDF files from IIIF manifests',
    version: '0.1.0',
  },
});

export const progressPath = middleware.path({
  description: `Provide a \`text/event-stream\` with progress updates for an ongoing PDF generation process, identified by a progress token.
    
  The stream can emit one of three events:
  - \`progress\`: Progress has been updated, has a \`ProgressStatus\` JSON payload
  - \`cancel\`: Signals that the client has cancelled the PDF generation
  - \`error\`: An error occurred during PDF generation, has a string payload with further information`,
  produces: ['text/event-stream'],
  parameters: [
    {
      name: 'token',
      in: 'path',
      description:
        'Progress token for PDF generation, must have been previously passed to the PDF endpoint with the `progressToken` parameter',
      required: true,
    },
  ],
  responses: {
    200: {
      content: {
        'text/event-stream': {
          schema: {
            type: 'object',
            required: [
              'totalPages',
              'pagesWritten',
              'bytesPushed',
              'bytesWritten',
              'writeSpeed',
              'remainingDuration',
            ],
            properties: {
              totalPages: {
                type: 'integer',
                description: 'Expected total number of pages in the final PDF',
              },
              pagesWritten: {
                type: 'integer',
                description:
                  'Number of pages that have been written to the PDF so far',
              },
              bytesPushed: {
                type: 'integer',
                description:
                  'Number of bytes that were pushed for writing to the PDF (but not neccessarily written yet) so far.',
              },
              bytesWritten: {
                type: 'integer',
                description:
                  'Number of bytes that were written to the PDF so far',
              },
              estimatedFileSize: {
                type: 'number',
                description:
                  'Estimated final size of the PDF in bytes, is continually updated.',
              },
              writeSpeed: {
                type: 'number',
                description:
                  'Speed in bytes per second at which the PDF is currently being written',
              },
              remainingDuration: {
                type: 'number',
                description:
                  'Estimated remaining duration until PDF is complete, in seconds',
              },
            },
          },
        },
      },
    },
  },
});

export const pdfPath = middleware.validPath({
  decription:
    'Generate a PDF from a IIIF manifest and stream it in the response',
  parameters: [
    {
      name: 'manifestUrl',
      in: 'query',
      description: 'URL to the manifest that should be converted to PDF',
      required: true,
      schema: {
        type: 'string',
      },
    },
    {
      name: 'canvasNos',
      in: 'query',
      description:
        'Indices (1-based) of the canvases that should be included in the PDF, can be a list of numbers (`1,3,5`), ranges (`1-5`) or a mix of both.',
      required: false,
      examples: {
        singlePages: {
          summary: 'Single canvases',
          value: ['1,3,5'],
        },
        ranges: {
          summary: 'Multiple ranges of canvases',
          value: ['1-5,7-9'],
        },
        mixed: {
          summary: 'Mix of single canvases and ranges',
          value: ['1,3,7-12'],
        },
      },
      style: 'form',
      schema: {
        type: 'array',
        items: {
          oneOf: [
            { type: 'integer', description: 'Single canvas index' },
            { type: 'string', description: 'Range of canvas indices' },
          ],
        },
      },
    },
    {
      name: 'locale',
      in: 'query',
      description:
        'Override the locale that will be used for generating metadata. By default, the locale is picked from the `Accept-Language` header, this parameter allows overriding it.',
      required: false,
      schema: {
        type: 'string',
      },
    },
    {
      name: 'progressToken',
      in: 'query',
      description:
        'Token that allows subscription to a stream of progress updates via the `/api/progress/{token}` endpoint.',
      required: false,
      schema: {
        type: 'string',
      },
    },
    {
      name: 'ppi',
      in: 'query',
      description:
        'Override the pixels-per-inch resolution for all canvases. By default, this will be determined from a IIIF Physical Dimensions service, if available, otherwise 300 ppi are assumed.',
      required: false,
      schema: {
        type: 'number',
      },
    },
    {
      name: 'maxWidth',
      in: 'query',
      description:
        'Limit the maximum width for images in the PDF to the set amount of pixels. Can be used to keep the size of the PDF down. Note that the server itself will perform no downscaling by itself, i.e. this only has an effect if the IIIF Image API endpoint for a given image supports downscaling, and if so, the closest value to the desired maximum width is picked.',
      required: false,
      schema: {
        type: 'number',
      },
    },
    {
      name: 'preferLossless',
      in: 'query',
      description:
        'Prefer lossless images (currently this always means PNG) to lossy (JPG). Increases the size of the resulting PDF significantly.',
      required: false,
      schema: {
        type: 'boolean',
      },
    },
  ],
  responses: {
    200: {
      content: {
        'application/pdf': {
          headers: {
            'Transfer-Encoding': 'chunked',
          },
        },
      },
    },
    400: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              validation: { type: 'object' },
              schema: { type: 'object' },
            },
          },
        },
      },
    },
  },
});

export const coverPath = middleware.validPath({
  description:
    'Generate a cover page PDF to be included in a PDF generated on the client',
  requestBody: {
    description: 'Parameters that specify the content of the cover page',
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['title', 'manifestUrl'],
          properties: {
            title: { type: 'string' },
            manifestUrl: { type: 'string' },
            thumbnail: {
              type: 'object',
              required: ['url'],
              properties: {
                url: { type: 'string' },
                iiifImageService: { type: 'string' },
              },
            },
            provider: {
              type: 'object',
              required: ['label'],
              properties: {
                label: { type: 'string' },
                homepage: { type: 'string' },
                logo: { type: 'string' },
              },
            },
            requiredStatement: {
              type: 'object',
              required: ['label', 'value'],
              properties: {
                label: { type: 'string' },
                value: { type: 'string' },
              },
            },
            rights: {
              type: 'object',
              required: ['text'],
              properties: {
                text: { type: 'string' },
                url: { type: 'string' },
                logo: { type: 'string' },
              },
            },
            metadata: {
              type: 'array',
              items: {
                type: 'array',
                minItems: 2,
                maxItems: 2,
                prefixItems: [
                  { type: 'string' },
                  {
                    oneOf: [
                      { type: 'string' },
                      { type: 'array', items: { type: 'string' } },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/pdf': {
          headers: {
            'Access-Control-Allow-Origin': '*"',
          },
        },
      },
    },
    400: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              validation: { type: 'object' },
              schema: { type: 'object' },
            },
          },
        },
      },
    },
  },
});
