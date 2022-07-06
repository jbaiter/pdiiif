/** Get a timestamp in milliseconds, prefereably high-resolution */
export function now(): number {
  if (typeof window !== 'undefined' && window.performance) {
    return window.performance.now();
  } else {
    return Date.now();
  }
}

export function isDefined<T>(val: T | undefined | null): val is T {
  return val != undefined && val !== null;
}
