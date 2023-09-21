import type { Histogram } from 'prom-client';
import prometheus from 'prom-client';

import { runningInNode } from './util.js';

type Metrics =
  | {
      pageGenerationDuration: Histogram<string>;
      imageFetchDuration: Histogram<string>;
      imageInfoDuration: Histogram<string>;
      ocrFetchDuration: Histogram<string>;
    }
  | undefined;

let metrics: Metrics;

// Prometheus metrics are only defined when running in node
if (runningInNode()) {
  metrics = {
    pageGenerationDuration: new prometheus.Histogram({
      name: 'pdiiif_page_generation_duration_seconds',
      help: 'Latency for generating the PDF for a single page',
      buckets: [0.001, 0.005, 0.015, 0.05, 0.1, 0.5, 1, 2],
      labelNames: ['status'],
    }),
    imageFetchDuration: new prometheus.Histogram({
      name: 'pdiiif_image_fetch_duration_seconds',
      help: 'Latency for fetching data from IIIF Image API endpoints',
      buckets: [0.01, 0.05, 0.15, 0.5, 1, 5, 10],
      labelNames: ['status', 'iiif_host', 'limited'],
    }),
    imageInfoDuration: new prometheus.Histogram({
      name: 'pdiiif_image_info_duration_seconds',
      help: 'Latency for fetching info from IIIF Image API endpoints',
      buckets: [0.01, 0.05, 0.15, 0.5, 1, 5, 10],
      labelNames: ['status', 'iiif_host', 'limited'],
    }),
    ocrFetchDuration: new prometheus.Histogram({
      name: 'pdiiif_ocr_fetch_duration_seconds',
      help: 'Latency for fetching OCR data',
      buckets: [0.01, 0.05, 0.15, 0.5, 1, 5, 10],
      labelNames: ['status', 'ocr_host', 'limited'],
    }),
  };
}

export default metrics;
