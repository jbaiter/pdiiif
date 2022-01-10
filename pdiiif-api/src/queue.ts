import PQueue from 'p-queue';

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
      this.queues.set(
        mainImageApiHost,
        new PQueue({ concurrency: this.maxConcurrency })
      );
    }
    const queue = this.queues.get(mainImageApiHost);
    const prom = queue.add(fn);
    let position = queue.size;
    if (onAdvance) {
      const onNext = () => {
        position = position - 1;
        if (position > 0) {
          onAdvance(position);
        } else {
          queue.removeListener('next', onNext);
        }
      }
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
