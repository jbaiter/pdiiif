import { IS_BIG_ENDIAN } from './util.js';

const PDF_INDENTATION = 2;

export interface Metadata {
  Producer?: string;
  Creator?: string;
  CreationDate?: Date;
  Title?: string;
  Author?: string;
  Keywords?: string;
  ModDate?: Date;
}

export interface PdfObject {
  num: number;
  data?: PdfValue;
  stream?: Uint8Array | string;
}

export class PdfRef {
  refObj: number;

  constructor(num: number) {
    this.refObj = num;
  }
}
export type PdfPrimitive =
  | string
  | number
  | boolean
  | Uint8Array
  | null
  | Date
  | PdfRef;
export interface PdfDictionary {
  [member: string]: PdfPrimitive | PdfArray | PdfDictionary;
}
export type PdfArray = Array<PdfPrimitive | PdfArray | PdfDictionary>;
export type PdfValue = PdfPrimitive | PdfDictionary | PdfArray | null;

export interface PdfAnnotation {
  Type: 'Annot';
  Subtype: string;
  Rect: [number, number, number, number];
  Contents: string | undefined;
  P?: PdfRef;
  NM?: string;
  M?: Date;
  F?: number;
  AP?: PdfDictionary;
  AS?: string;
  Border?: [number, number, number] | [number, number, number, number];
  C?:
    | []
    | [number]
    | [number, number, number]
    | [number, number, number, number];
}

export interface StructTreeEntry {
  type: 'Sect' | 'P' | 'Span';
  children: Array<StructTreeEntry>; // Only for `Sect` and `P` entries
  pageObjNum: number;
  mcs: Array<number>; // Only for `Span` entries
}

export function makeRef(target: number | PdfObject): PdfRef {
  const num = typeof target === 'number' ? target : target.num;
  return new PdfRef(num);
}

function isUnicode(str: string): boolean {
  for (let i = 0, end = str.length; i < end; i++) {
    if (str.charCodeAt(i) > 0x7f) {
      return true;
    }
  }
  return false;
}

/** Convert a JS UTF8 string to a UTF16 Big Endian string */
export function toUTF16BE(str: string, includeBom = true): Uint8Array {
  const buf = new Uint16Array(str.length + (includeBom ? 1 : 0));
  for (let i = includeBom ? 1 : 0; i < buf.length; i++) {
    buf[i] = str.charCodeAt(i - (includeBom ? 1 : 0));
  }
  const outBuf = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  if (!IS_BIG_ENDIAN) {
    // PDF needs UTF16-BE, so in little endian systems we need to swap each
    // codepoint's byte pair
    for (let i = includeBom ? 2 : 0, end = outBuf.length - 1; i < end; i += 2) {
      const a = outBuf[i];
      outBuf[i] = outBuf[i + 1];
      outBuf[i + 1] = a;
    }
  }
  // UTF16BE BOM
  if (includeBom) {
    outBuf[0] = 254;
    outBuf[1] = 255;
  }
  return outBuf;
}

function safeNumber(num: number): number {
  if (num > -1e21 && num < 1e21) {
    return Math.round(num * 1e6) / 1e6;
  }
  throw new Error(`unsupported number: ${num}`);
}

export function serialize(value: PdfValue, dictIndent = 0): string {
  if (typeof value === 'string') {
    if (
      value[0] === '(' &&
      value[value.length - 1] === ')' &&
      isUnicode(value)
    ) {
      return serialize(toUTF16BE(value.substring(1, value.length - 1)));
    }
    return value;
  } else if (value instanceof Uint8Array) {
    return `<${Array.from(value)
      .map((x) => x.toString(16).padStart(2, '0').toUpperCase())
      .join('')}>`;
  } else if (value instanceof Date) {
    const dateString =
      `D:${value.getUTCFullYear().toString(10).padStart(4, '0')}` +
      (value.getUTCMonth() + 1).toString(10).padStart(2, '0') +
      value.getUTCDate().toString(10).padStart(2, '0') +
      value.getUTCHours().toString(10).padStart(2, '0') +
      value.getUTCMinutes().toString(10).padStart(2, '0') +
      value.getUTCSeconds().toString(10).padStart(2, '0') +
      'Z';
    return `(${dateString})`;
  } else if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v, dictIndent + 1)).join(' ')}]`;
  } else if (value instanceof PdfRef) {
    if (value.refObj === -1) {
      throw new Error('Cannot serialize a deferred object reference');
    }
    return `${value.refObj} 0 R`;
  } else if ({}.toString.call(value) === '[object Object]') {
    const outsideIndent = ' '.repeat(PDF_INDENTATION * dictIndent);
    const insideIndent = outsideIndent + ' '.repeat(PDF_INDENTATION);
    return `<<\n${Object.entries(value as any)
      .map(
        ([k, v]) =>
          `${insideIndent}/${k} ${serialize(v as any, dictIndent + 1)}`
      )
      .join('\n')}\n${outsideIndent}>>`;
  } else if (typeof value === 'number') {
    return safeNumber(value).toString(10);
  } else {
    return `${value}`;
  }
}
