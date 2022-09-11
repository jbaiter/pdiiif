import PQueue from 'p-queue';

import metrics from './metrics.js';

export class GeneratorQueue {
  private maxConcurrency: number;
  private queues: Map<string, PQueue> = new Map();

  constructor(maxConcurrency = 2) {
    this.maxConcurrency = maxConcurrency;
  }

  async add<R>(
    fn: (() => PromiseLike<R>) | (() => R),
    mainImageApiHost: string,
    onAdvance?: (pos: number) => void
  ): Promise<R> {
    if (!this.queues.has(mainImageApiHost)) {
      let q;
      // FIXME: Why is this neccessary?
      if ('default' in PQueue) {
        q = new (PQueue as any).default({ concurrency: this.maxConcurrency });
      } else {
        q = new PQueue({ concurrency: this.maxConcurrency });
      }
      q.addListener('add', () =>
        metrics.generatorQueueSize.set({ iiif_host: mainImageApiHost }, q.size)
      );
      q.addListener('next', () =>
        metrics.generatorQueueSize.set({ iiif_host: mainImageApiHost }, q.size)
      );
      this.queues.set(mainImageApiHost, q);
    }
    const queue = this.queues.get(mainImageApiHost)!;
    const prom = queue.add(fn);
    let position = queue.size;
    if (position > 0 && onAdvance) {
      const onNext = () => {
        position = position - 1;
        if (position > 0) {
          onAdvance(position);
        } else {
          queue.removeListener('next', onNext);
        }
      };
      queue.on('next', onNext);
      onAdvance(position);
      return prom.finally(() => queue.removeListener('next', onNext));
    } else {
      return prom;
    }
  }

  size(imageApiHost: string): number {
    return this.queues.get(imageApiHost)?.size ?? 0;
  }
}
