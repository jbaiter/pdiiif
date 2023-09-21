import util from 'util';
import zlib from 'zlib';
import { zlibSync } from 'fflate';
import nodeCrypto from 'crypto';

import { StartCanvasInfo } from '../download.js';
import { PdfDictionary } from './common.js';
import log from '../log.js';
import { runningInNode } from '../util.js';

// Browsers have native encoders/decoders in the global namespace, use these
export let textEncoder: TextEncoder | util.TextEncoder;
export let textDecoder: TextDecoder | util.TextDecoder;
if (typeof TextEncoder !== 'undefined' && typeof TextDecoder !== 'undefined') {
  textEncoder = new TextEncoder();
  textDecoder = new TextDecoder();
} else {
  textEncoder = new util.TextEncoder();
  textDecoder = new util.TextDecoder();
}

// If running in node, use the web compatible crypto implementation
let cryptoImpl: Crypto;
if (runningInNode()) {
  cryptoImpl = nodeCrypto.webcrypto as Crypto;
} else {
  cryptoImpl = crypto;
}

export const IS_BIG_ENDIAN = (() => {
  const array = new Uint8Array(4);
  const view = new Uint32Array(array.buffer);
  return !((view[0] = 1) & array[0]);
})();

export interface TocItem {
  label: string;
  children?: Array<TocItem>;
  startCanvas: StartCanvasInfo;
}

export function getNumChildren(itm: TocItem): number {
  const children = itm.children ?? [];
  return (
    children.length + children.map(getNumChildren).reduce((a, b) => a + b, 0)
  );
}

export function randomData(length: number): Uint8Array {
  if (length > 2 ** 16) {
    length = 2 ** 16;
  }
  const buf = new Uint8Array(length);
  if (cryptoImpl !== undefined) {
    cryptoImpl.getRandomValues(buf);
  } else {
    const u32View = new Uint32Array(buf.buffer);
    for (let i = 0; i < u32View.length; i++) {
      u32View[i] = Math.floor(Math.random() * 2 ** 32);
    }
  }
  return buf;
}

export async function tryDeflateStream(
  pdfStream: Uint8Array | string
): Promise<{ stream: Uint8Array | string; dict: PdfDictionary }> {
  const data =
    pdfStream instanceof Uint8Array ? pdfStream : textEncoder.encode(pdfStream);
  let compressed: Uint8Array;
  if (!runningInNode()) {
    if (typeof CompressionStream === 'undefined') {
      // Browser doesn't support CompressionStream API, try to use the JS implementation
      try {
        let bytes: Uint8Array;
        if (pdfStream instanceof Uint8Array) {
          bytes = pdfStream;
        } else {
          bytes = textEncoder.encode(pdfStream);
        }
        compressed = zlibSync(bytes);
        return Promise.resolve({
          stream: compressed,
          dict: { Length: compressed.length, Filter: '/FlateDecode' },
        });
      } catch (err) {
        log.warn(
          `Failed to use JS deflate implementation, data will be written uncompressed: ${err}`
        );
        return Promise.resolve({
          stream: pdfStream,
          dict: { Length: pdfStream.length },
        });
      }
    }
    const compStream = new CompressionStream('deflate');
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
