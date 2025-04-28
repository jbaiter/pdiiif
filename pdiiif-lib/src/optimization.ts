import type { EncodeOptions } from '@jsquash/jpeg/meta';
import { randomUUIDv4 } from './util';
import OptimizationWorker from './optimization.worker.ts?worker';
import log from './log';

export type InitializationRequest = {
  mozjpegWasm: Uint8Array;
};

export type TaskDescription<I> = {
  id: string;
  data: I;
};

export type WorkerMessage<I, O> = { input: { id: string; data: I }; result: O };
export type WorkerTask<I, O> = {
  resolve: (value: O) => void;
  reject: (reason: any) => void;
  task: TaskDescription<I>;
};

export type MozJPEGParams = {
  method: 'mozjpeg';
  quality: number;
} & Partial<EncodeOptions>;

export type BrowserEncoderParams = {
  method: 'browser';
  quality: number;
};

export type OptimizationParams = MozJPEGParams | BrowserEncoderParams;

export type OptimizationRequest = {
  imageData: Uint8Array;
  imageFormat: 'image/jpeg' | 'image/png';
} & OptimizationParams;

export type OptimizedImage = {
  jpegData: Uint8Array;
  sizeFactor: number;
};

export class OptimizationError extends Error {
  constructor(message: string, public taskId: string, public cause?: unknown) {
    super(message);
  }
}

export const MOZJPEG_DEFAULT_PARAMS: EncodeOptions = {
  quality: 75,
  progressive: true,
  optimize_coding: true,
  smoothing: 0,
  color_space: 3, // YCbCr
  quant_table: 3,
  trellis_multipass: false,
  trellis_opt_table: true,
  trellis_opt_zero: true,
  trellis_loops: 0,
  auto_subsample: false,
  chroma_subsample: 2,
  separate_chroma_quality: false,
  chroma_quality: 75,
  arithmetic: false,
  baseline: false,
};

class WorkerPool<I, O> {
  private workers: Worker[] = [];
  private queue: WorkerTask<I, O>[] = [];
  private pendingTasks: Map<string, WorkerTask<I, O>> = new Map();
  private busyWorkers: Set<Worker> = new Set();

  constructor(public size: number) {}

  start(): void {
    for (let i = 0; i < this.size; i++) {
      const worker = new OptimizationWorker();
      worker.onmessage = this.handleMessage.bind(this, worker);
      worker.onerror = this.handleError.bind(this, worker);
      this.workers.push(worker);
    }
  }

  stop(): void {
    this.workers.forEach((worker) => worker.terminate());
    this.workers = [];
    this.queue = [];
    this.busyWorkers.clear();
  }

  dispatch(data: I): Promise<O> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        resolve,
        reject,
        task: {
          id: randomUUIDv4(),
          data,
        },
      });
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.queue.length === 0) return;
    const availableWorker = this.workers.find((w) => !this.busyWorkers.has(w));
    if (!availableWorker) return;

    const job = this.queue.shift()!;
    this.pendingTasks.set(job.task.id, job);
    this.busyWorkers.add(availableWorker);
    availableWorker.postMessage(job.task);
  }

  private handleMessage(
    worker: Worker,
    event: MessageEvent<WorkerMessage<I, O>>
  ): void {
    log.debug(`worker: received message`, event.data);
    const job = this.pendingTasks.get(event.data.input.id);
    if (job) {
      job.resolve(event.data.result);
      log.debug(`worker: resolved job`, job.task.id);
      this.pendingTasks.delete(job.task.id);
      this.busyWorkers.delete(worker);
      this.processQueue();
    } else {
      log.warn(
        `worker: unknown job, known jobs: ${[...this.pendingTasks.keys()].join(
          ', '
        )}`,
        event.data.input.id
      );
    }
  }

  private handleError(worker: Worker, evt: ErrorEvent): void {
    const optimError = evt.error as OptimizationError;
    const job = this.queue.find((j) => j.task.id === optimError.taskId);
    if (job) {
      job.reject(optimError.cause);
      this.busyWorkers.delete(worker);
      this.processQueue();
    }
  }
}

let pool: WorkerPool<
  OptimizationParams | InitializationRequest,
  OptimizedImage | undefined
> | null = null;
let isInitialized = false;

export function startWorkerPool(size = navigator.hardwareConcurrency): void {
  if (pool !== null) {
    return;
  }
  pool = new WorkerPool(size);
  pool.start();
}

export function stopWorkerPool(): void {
  if (pool === null) {
    return;
  }
  pool.stop();
  pool = null;
}

export async function initialize(wasmLoader: () => Promise<Uint8Array>): Promise<void> {
  if (pool === null) {
    startWorkerPool();
  }

  if (isInitialized) {
    return;
  }

  const mozjpegWasm = await wasmLoader();
  let promises: Promise<undefined>[] = [];
  for (let i = 0; i < pool!.size; i++) {
    promises.push(pool!.dispatch({ mozjpegWasm }) as Promise<undefined>);
  }
  log.debug('main: mozjpegWasm sent to workers');
  await Promise.all(promises);
  log.debug('main: workers initialized with MozJPEG encoder');
  isInitialized = true;
}

export async function optimizeImage(
  params: OptimizationRequest
): Promise<OptimizedImage> {
  if (pool === null) {
    startWorkerPool();
  }

  return pool!.dispatch(params) as Promise<OptimizedImage>;
}
