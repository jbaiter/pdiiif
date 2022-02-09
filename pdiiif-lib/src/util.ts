/** Get a timestamp in milliseconds, prefereably high-resolution */
export function now(): number {
  if (typeof window !== 'undefined' && window.performance) {
    return window.performance.now();
  } else {
    return Date.now();
  }
}