export let saxParserWasm: Uint8Array | null = null;

/** Get a timestamp in milliseconds, prefereably high-resolution */
export function now(): number {
  if (typeof window !== 'undefined' && window.performance) {
    return window.performance.now();
  } else {
    return Date.now();
  }
}

export function isDefined<T>(val: T | undefined | null | void): val is T {
  return val != undefined && val !== null && val !== void 0;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; ++i) {
    let c = i, k = 9;
    while (--k) c = ((c & 1) && -306674912) ^ (c >>> 1);
    t[i] = c;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < data.length; ++i) {
    c = CRC_TABLE[(c & 255) ^ data[i]] ^ (c >>> 8);
  }
  return ~c;
}

export function runningInNode(): boolean {
  return typeof process !== 'undefined' && typeof process.versions?.node !== 'undefined';
}

export function initializeSaxParser(parserWasm: Uint8Array): void {
  saxParserWasm = parserWasm;
}

export function randomUUIDv4() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    if (c !== 'x') {
      return c;
    }
    const randomInteger = (Math.random() * 16) | 0;
    const encoded = (randomInteger & 0x3) | 0x8;
    return encoded.toString(16);
  });
}
