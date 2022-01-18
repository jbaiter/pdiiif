/** Get a timestamp in milliseconds, prefereably high-resolution */
export function now(): number {
  if (typeof window !== 'undefined' && window.performance) {
    return window.performance.now();
  } else {
    return Date.now();
  }
}

// TODO: Use `AbortController` instead to improve responsiveness, since
//       we can completely abort long-running `fetch` requests with it
/** Function that gets triggered whenever a cancellation was successful. */
export type CancelCallback = () => void;
/** Token used for managing the cancellation of long processes. */
export class CancelToken {
  isCancellationRequested = false;
  isCancellationConfirmed = false;
  onCancelled: CancelCallback[] = [];

  /** Request cancellation, promise resolved when cancellation has been confirmed. */
  requestCancel(): Promise<void> {
    const promise: Promise<void> = new Promise((resolve) =>
      this.addOnCancelled(resolve)
    );
    this.isCancellationRequested = true;
    return promise;
  }

  /** Confirm successful cancellation, call this when all resources have been cleaned up. */
  confirmCancelled(): void {
    if (this.isCancellationConfirmed) {
      return;
    }
    this.isCancellationConfirmed = true;
    this.onCancelled.forEach((cb) => cb());
  }

  /** Add a callback for when a cancellation is confirmed. */
  addOnCancelled(cb: CancelCallback): void {
    this.onCancelled.push(cb);
  }

  /** Check if the cancellation has been requested or confirmed. */
  get cancelled(): boolean {
    return this.isCancellationRequested || this.isCancellationConfirmed;
  }

  /** You can simply `await` this token to wait for the cancellation to be confirmed. */
  then(resolve: () => void): void {
    this.onCancelled.push(() => resolve());
  }
}

