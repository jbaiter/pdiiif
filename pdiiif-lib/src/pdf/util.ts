import sum from 'lodash/sum';
import util from 'util';
import zlib from 'zlib';

import { PdfDictionary } from './common';

// Browsers have native encoders/decoders in the global namespace, use these
export let textEncoder: TextEncoder | util.TextEncoder;
export let textDecoder: TextDecoder | util.TextDecoder;
if (typeof window !== 'undefined' && window.TextEncoder && window.TextDecoder) {
  textEncoder = new window.TextEncoder();
  textDecoder = new window.TextDecoder();
} else {
  textEncoder = new util.TextEncoder();
  textDecoder = new util.TextDecoder();
}

export const IS_BIG_ENDIAN = (() => {
  const array = new Uint8Array(4);
  const view = new Uint32Array(array.buffer);
  return !((view[0] = 1) & array[0]);
})();

export interface TocItem {
  label: string;
  children?: Array<TocItem>;
  startCanvasIdx?: number;
}

export function getNumChildren(itm: TocItem): number {
  const children = itm.children ?? [];
  return children.length + sum(children.map(getNumChildren));
}

export function randomData(length: number): Uint8Array {
  if (length > 2 ** 16) {
    length = 2 ** 16;
  }
  const buf = new Uint8Array(length);
  if (typeof window !== 'undefined' && window?.crypto) {
    crypto.getRandomValues(buf);
  } else if (typeof (global as any)?.crypto !== 'undefined') {
    return new Uint8Array((global as any).crypto(length));
  } else {
    const u32View = new Uint32Array(buf.buffer);
    for (let i = 0; i < u32View.length; i++) {
      u32View[i] = Math.floor(Math.random() * 2 ** 32);
    }
  }
  return buf;
}

export function findLastIndex<T>(
  array: Array<T>,
  predicate: (value: T, index: number, obj: Array<T>) => boolean
): number {
  let l = array.length;
  while (l--) {
    if (predicate(array[l], l, array)) return l;
  }
  return -1;
}

export async function tryDeflateStream(
  pdfStream: Uint8Array | string
): Promise<{ stream: Uint8Array | string; dict: PdfDictionary }> {
  const data =
    pdfStream instanceof Uint8Array ? pdfStream : textEncoder.encode(pdfStream);
  let compressed: Uint8Array;
  if (typeof window !== 'undefined') {
    if (typeof (window as any).CompressionStream === 'undefined') {
      // Browser doesn't support CompressionStream API, no deflate possible
      return Promise.resolve({
        stream: pdfStream,
        dict: { Length: pdfStream.length },
      });
    }
    const compStream = new (window as any).CompressionStream('deflate');
    const c = new Blob([data]).stream().pipeThrough(compStream);
    compressed = new Uint8Array(await new Response(c).arrayBuffer());
  } else {
    compressed = await new Promise((resolve, reject) =>
      zlib.deflate(data, (err, buf) => (err ? reject(err) : resolve(buf)))
    );
  }
  return {
    dict: {
      Length: compressed.length,
      Filter: '/FlateDecode',
    },
    stream: compressed,
  };
}
