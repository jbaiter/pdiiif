import prometheus from 'prom-client';

const metrics = {
  coverPageRenderDuration: new prometheus.Histogram({
    name: 'pdiiif_coverpage_render_duration_seconds',
    help: 'Latency for generating a cover page',
    buckets: [0.1, 0.5, 1, 2, 4, 8],
    labelNames: ['status'],
  }),
  coverPageInfoDuration: new prometheus.Histogram({
    name: 'pdiiif_coverpage_info_duration_seconds',
    help: 'Latency for fetching info.json during cover page generation',
    buckets: [0.1, 0.3, 0.5, 1, 2, 4, 8],
    labelNames: ['status', 'iiif_host'],
  }),
}

export default metrics;