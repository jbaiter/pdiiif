import { Reader } from '../io.js';
import { PdfObject, PdfValue, PdfDictionary, PdfRef } from './common.js';
import { textDecoder, textEncoder } from './util.js';

// Polyfill Uint8Array.findLastIndex for older browsers
if (!Uint8Array.prototype.findLastIndex) {
  Uint8Array.prototype.findLastIndex = function (
    predicate: (value: number, index: number, obj: Uint8Array) => boolean
  ): number {
    let l = this.length;
    while (l--) {
      if (predicate(this[l], l, this)) return l;
    }
    return -1;
  };
}

const ESCAPE_CHARS: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  '(': '(',
  ')': ')',
  '\\': '\\',
};

//          offset/nextFree|generation|inUse?
//                      ▼       ▼        ▼
type CrossRefEntry = [number, number, boolean];
interface CrossRefSubSection {
  startNum: number;
  numObjs: number;
  entries: Array<CrossRefEntry>;
}

/** Parse a section of the x-ref table, yielding `CrossRefSubSection` objects as
 *  we encounter them.
 *
 * @param reader The reader to read from.
 * @param offset The offset of the x-ref section in the file.
 * @param length The length of the x-ref section.
 */
async function* parseCrossRefSection(
  reader: Reader,
  offset: number,
  length: number
): AsyncGenerator<CrossRefSubSection> {
  const buf = new Uint8Array(length);
  offset += await reader.read(buf, 0, offset, buf.length);
  if (!testForString(buf, 0, 'xref')) {
    throw 'Invalid crossreference section, did not start with `xref` line.';
  }
  const trailerIdx = buf.findIndex((_x, idx) =>
    testForString(buf, idx, 'trailer')
  );
  // Split into lines and skip first line (`xref`)
  const parts = textDecoder
    .decode(buf.subarray(0, trailerIdx))
    .split(/[\r ]?\n/)
    .slice(1);
  let currentSection: CrossRefSubSection | undefined;
  for (const part of parts) {
    // Entries have length 18 (we stripped the newline already)
    if (part.length === 18) {
      if (!currentSection) {
        throw 'Invalid crossreference section, entry outside of subsection.';
      }
      const entryParts = part.trim().split(' ');
      currentSection.entries.push([
        Number.parseInt(entryParts[0], 10),
        Number.parseInt(entryParts[1], 10),
        entryParts[2] === 'n',
      ]);
    } else {
      if (currentSection) {
        if (currentSection.numObjs !== currentSection.entries.length) {
          throw `Invalid subsection, expected ${currentSection.numObjs} objects, found ${currentSection.entries.length}!`;
        }
        yield currentSection;
        currentSection = undefined;
      }
      if (part.length === 0 || part.indexOf('trailer') >= 0) {
        break;
      }
      const [startNum, numObjs] = part
        .trimEnd()
        .split(' ')
        .map((p) => Number.parseInt(p, 10));
      currentSection = {
        startNum,
        numObjs,
        entries: [],
      };
    }
  }
  if (currentSection) {
    yield currentSection;
  }
  const trailerBuf = buf.subarray(trailerIdx);
  const trailerStartIdx = trailerBuf.findIndex((_x, idx) =>
    testForString(trailerBuf, idx, '<<')
  );
  const trailerEndIdx = trailerBuf.findIndex((_x, idx) =>
    testForString(trailerBuf, idx, '>>')
  );

  const trailerDict = new PdfValueParser(
    trailerBuf.subarray(trailerStartIdx, trailerEndIdx + 2)
  ).read() as PdfDictionary;
  if (trailerDict.Prev) {
    const previousXrefOffset = trailerDict.Prev as number;
    yield* parseCrossRefSection(
      reader,
      previousXrefOffset,
      offset - previousXrefOffset
    );
  }
}

/** Look for a string from a given location in a buffer. */
function testForString(
  buf: Uint8Array,
  offset: number,
  value: string,
  backwards = false
): boolean {
  if (backwards) {
    for (let idx = value.length - 1; idx >= 0; idx--) {
      if (buf[offset + idx] !== value.charCodeAt(idx)) {
        return false;
      }
    }
  } else {
    for (let idx = 0; idx < value.length; idx++) {
      if (buf[offset + idx] !== value.charCodeAt(idx)) {
        return false;
      }
    }
  }
  return true;
}

/** Check if a string is the representation of an integer digit */
function isDigit(c: string): boolean {
  return !isNaN(parseInt(c, 10));
}

/** Check if a character is a hexadecimal digit ([0-9a-fA-F])  */
function isHex(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x46) ||
    (c >= 0x61 && c <= 0x66)
  );
}

/** Parse a PDF "value", which can be one of:
 * - number (integer or float)
 * - string
 * - name (represented as a JS string starting with `/`)
 * - boolean
 * - null
 * - date
 * - XRef
 * - Array
 * - Dictionary
 *
 * API walkthrough:
 * - `read()` is the main entry point, it will read the next value from the
 *   buffer and advance the cursor
 *  - `match*` methods check if the buffer at the current offset matches a
 *    certain type of value, either returning a boolean or the section of the
 *    buffer containing the value as a string.
 *  - `read*` methods read a value of a specific type from the buffer and
 *    advance the cursor
 */
export class PdfValueParser {
  start = 0;
  current = 0;
  private readonly buf: Uint8Array;

  /** Construct a parser for a buffer containing one or more PDF values. */
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  /** Get the buffer content at the current offset as a character. */
  private getChar(): string {
    return String.fromCharCode(this.buf[this.current]);
  }

  /** Compares the buffer contents at the current offset against a string value. */
  private matchValue(value: string): boolean {
    const valueRead = textDecoder.decode(
      this.buf.subarray(
        this.current,
        this.current + textEncoder.encode(value).length
      )
    );
    return valueRead === value;
  }

  /** Checks if the buffer at the current offset contains a number.
   *
   * See ISO32000-2:2020 section 7.3.3.
   */
  private matchInteger(resetAfter = true): string | undefined {
    this.start = this.current;
    let chr: string;
    let isInt = true;
    const chars: string[] = [];
    while (
      !this.matchWhiteSpace((chr = this.getChar())) &&
      !this.matchDelimiter(chr)
    ) {
      if (chr === '+' || chr === '-') {
        if (this.current - this.start > 0) {
          isInt = false;
          break;
        }
      } else if (!isDigit(chr)) {
        isInt = false;
        break;
      }
      this.current++;
      chars.push(chr);
    }
    if (resetAfter) {
      this.current = this.start;
    }
    return isInt ? chars.join('') : undefined;
  }

  /** Read a PDF value from the current offset, advancing the cursor. */
  read(): PdfValue {
    let c = this.getChar();
    if (this.matchWhiteSpace(c)) {
      this.skipWhiteSpace();
      c = this.getChar();
    }
    switch (this.getChar()) {
      case '[':
        return this.readArray();
      case '<':
        return this.matchValue('<<') ? this.readDict() : this.readHexString();
      case '(':
        return this.readLiteralString();
      case '/':
        return this.readName();
      case 't':
        if (this.matchValue('true')) {
          this.current += 'true'.length;
          return true;
        }
        throw new Error('Unexpected character while parsing');
      case 'f':
        if (this.matchValue('false')) {
          this.current += 'false'.length;
          return false;
        }
        throw new Error('Unexpected character while parsing');
      case 'n':
        if (this.matchValue('null')) {
          this.current += 'null'.length;
          return null;
        }
        throw new Error('Unexpected character while parsing');
      case '.':
        return this.readRealNumber();
      default:
        if (this.matchIndirectObject()) {
          return this.readIndirectObject();
        }
        if (this.matchRealNumber()) {
          return this.readRealNumber();
        }
        if (this.matchInteger()) {
          return this.readInteger();
        }
        throw new Error(
          `Encountered unexpected character during parsing: '${c}'`
        );
    }
  }

  /** Check if the input string contains PDF whitespace.
   *
   * See ISO32000-2:2020 section 7.2.3, Table 1.
   */
  matchWhiteSpace(c: string): boolean {
    return (
      c === ' ' ||
      c === '\x00' ||
      c === '\n' ||
      c === '\r' ||
      c === '\r\n' ||
      c == '\x0C'
    );
  }

  /** Read an integer from the current offset. */
  readInteger(): number {
    const intStr = this.matchInteger(false);
    if (intStr === undefined) {
      throw new Error('Failed to read integer.');
    }
    return Number.parseInt(intStr, 10);
  }

  /** Read an indirect object from the current offset. */
  readIndirectObject(): PdfRef {
    const match = this.matchIndirectObject(false);
    if (match === undefined) {
      throw new Error('Failed to read indirect object');
    }
    return new PdfRef(Number.parseInt(match.split(' ')[0]));
  }

  /** Check if the buffer contains an indirect object at the current offset.
   *
   * See ISO32000-2:2020 section 7.3.10.
   */
  matchIndirectObject(resetAfter = true): string | undefined {
    this.start = this.current;
    let c = this.getChar();
    const chars: string[] = [];
    const matchNumber = (): boolean => {
      if (!isDigit(c)) {
        return false;
      }
      chars.push(c);
      this.current++;
      while (isDigit((c = this.getChar()))) {
        chars.push(c);
        this.current++;
      }
      return true;
    };
    const matchWhitespace = (): boolean => this.skipWhiteSpace();
    // Using a closure makes resetting afterwards less verbose
    const match = (): boolean => {
      // Object number
      if (!matchNumber()) {
        return false;
      }
      if (!matchWhitespace()) {
        return false;
      }
      chars.push(' ');
      c = this.getChar();
      // Generation number
      if (!matchNumber()) {
        return false;
      }
      if (!matchWhitespace()) {
        return false;
      }
      chars.push(' ');
      if (this.getChar() !== 'R') {
        return false;
      }
      chars.push('R');
      this.current++;
      return true;
    };
    const doesMatch = match();
    if (resetAfter) {
      this.current = this.start;
    }
    if (doesMatch) {
      return chars.join('');
    }
  }

  /** Check if the buffer contains a real number at the current offset.
   *
   * See ISO32000-2:2020 section 7.3.3.
   */
  matchRealNumber(resetAfter = true): string | undefined {
    this.start = this.current;
    let isRealNumber = true;
    let digitSeen = false;
    let separatorSeen = false;
    const chars: string[] = [];
    let c: string;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      c = this.getChar();
      if (c === '.') {
        if (separatorSeen) {
          isRealNumber = false;
          break;
        }
        separatorSeen = true;
      } else if (isDigit(c)) {
        digitSeen = true;
      } else if (c === '-' || c === '+') {
        if (this.current - this.start > 0) {
          break;
        }
      } else {
        break;
      }
      chars.push(c);
      this.current++;
    }
    if (resetAfter) {
      this.current = this.start;
    }
    if (!isRealNumber) {
      return undefined;
    }
    if (digitSeen && separatorSeen) {
      return chars.join('');
    }
    return undefined;
  }

  /** Read a real number from the current offset. */
  readRealNumber(): number {
    const str = this.matchRealNumber(false);
    if (!str) {
      throw new Error('Could not read real number.');
    }
    return Number.parseFloat(str);
  }

  /** Skip a contiguous sequence of whitespae, advancing the cursor. */
  skipWhiteSpace(): boolean {
    let skipped = false;
    while (!this.atEnd() && this.matchWhiteSpace(this.getChar())) {
      this.current++;
      skipped = true;
    }
    return skipped;
  }

  /** Check if we're at the end of the buffer. */
  atEnd(): boolean {
    return this.current >= this.buf.length;
  }

  /** Read a name from the current offset.
   *
   * See ISO32000-2:2020 section 7.3.5.
   */
  readName(): PdfValue {
    const chars: string[] = ['/'];
    this.current++;
    let c: string;
    while (
      !this.matchWhiteSpace((c = this.getChar())) &&
      !this.matchDelimiter(c)
    ) {
      if (c === '#') {
        const a = this.buf[this.current++];
        const b = this.buf[this.current++];
        if (!isHex(a) || !isHex(b)) {
          throw new Error('Illegal character escape in name.');
        }
        chars.push(
          String.fromCharCode(
            Number.parseInt(String.fromCharCode(a) + String.fromCharCode(b), 16)
          )
        );
      } else {
        chars.push(c);
        this.current++;
      }
    }
    return chars.join('');
  }

  /** Check if the current offset contains a delimiter.
   *
   * See ISO32000-2:2020 section 7.2.3, Table 2
   */
  matchDelimiter(c: string): boolean {
    return '[]{}()<>/%'.indexOf(c) >= 0;
  }

  /** Read a hex string from the current offset.
   *
   * See ISO32000-2:2020 section 7.3.4.3
   */
  readHexString(): PdfValue {
    this.current++;
    const vals: Array<number> = [];
    while (this.getChar() !== '>') {
      const a = this.buf[this.current++];
      const b = this.buf[this.current++];
      if (!isHex(a) || !isHex(b)) {
        throw new Error(`Invalid value in hex string: '${a}${b}`);
      }
      vals.push(
        Number.parseInt(String.fromCharCode(a) + String.fromCharCode(b), 16)
      );
    }
    this.current++;
    return new Uint8Array(vals);
  }

  /** Read a literal string from the current offset.
   *
   * See ISO32000-2:2020 section 7.3.4.2
   */
  readLiteralString(): PdfValue {
    this.current++;
    const chars: string[] = [];
    let openParens = 0;
    let c: string;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      c = this.getChar();
      if (c === '\\') {
        this.current++;
        c = this.getChar();
        if (isDigit(c)) {
          let cs = [c];
          this.current++;
          while (isDigit(this.getChar())) {
            cs.push(this.getChar());
            this.current++;
          }
          if (cs.length > 3) {
            this.current -= cs.length - 3;
            cs = cs.slice(0, 3);
          }
          this.current--;
          c = String.fromCharCode(Number.parseInt(cs.join(''), 8));
        } else {
          c = ESCAPE_CHARS[c];
          if (c === undefined) {
            throw new Error(
              `Illegal escape sequence in string literal: '\\${c}`
            );
          }
        }
      } else if (c === '(') {
        openParens++;
      } else if (c === ')') {
        openParens--;
        if (openParens < 0) {
          this.current++;
          return chars.join('');
        }
      }
      chars.push(c);
      this.current++;
    }
  }

  /** Read a dictionary from the current offset.
   *
   * See ISO32000-2:2020 section 7.3.7
   */
  readDict(): PdfValue {
    this.current += 2;
    const obj: Record<string, PdfValue> = {};
    this.skipWhiteSpace();
    while (this.getChar() !== '>') {
      const name = this.read();
      if (typeof name !== 'string' || !name.startsWith('/')) {
        throw new Error(`Dictionary keys must be name objects, got '${name}`);
      }
      this.skipWhiteSpace();
      const val = this.read();
      if (val !== null) {
        obj[name.substring(1)] = val;
      }
      this.skipWhiteSpace();
    }
    this.current += 2;
    return obj;
  }

  /** Read an array from the current offset.
   *
   * See ISO32000-2:2020 section 7.3.6
   */
  readArray(): Array<PdfValue> {
    this.current++;
    const arr: Array<PdfValue> = [];
    while (this.getChar() !== ']') {
      arr.push(this.read());
      this.skipWhiteSpace();
    }
    this.current++;
    return arr;
  }
}

/** Minimalist low-level PDF parser operating on a Reader object.
 *
 * Currently only supports discovering page objects and annotation objects, as well
 * as obtaining arbitrary objects given the object number and generation.
 */
export class PdfParser {
  private reader: Reader;
  private objectOffsets: Array<number>;
  private sortedOffsets: Array<number>;
  pdfSize: any;
  objGenerations: number[];
  infoNum: number;
  catalogNum: number;

  /** Construct a new parser from a Reader.
   *
   * Used instead of the constructor to allow for async initialization.
   */
  static async parse(reader: Reader): Promise<PdfParser> {
    const trailerBuf = new Uint8Array(1024);
    const pdfSize = await reader.size();
    const bufStart = pdfSize - trailerBuf.length;
    await reader.read(trailerBuf, 0, bufStart, trailerBuf.length);
    const eofIdx =
      trailerBuf.length - (trailerBuf[trailerBuf.length - 1] === 0x46 ? 5 : 6);
    if (!testForString(trailerBuf, eofIdx, '%%EOF')) {
      throw 'Invalid PDF, missing EOF comment at end of file';
    }
    const startXrefPos = trailerBuf.findLastIndex((_x, idx) =>
      testForString(trailerBuf, idx, 'startxref')
    );
    if (startXrefPos < 0) {
      throw 'Invalid PDF, missing startxref marker in file trailer.';
    }
    const objGenerations: Array<number> = [];
    const objsDeleted: Array<boolean> = [];
    const objOffsets: Array<number> = [];
    const xrefStartOffset = Number.parseInt(
      textDecoder.decode(trailerBuf.subarray(startXrefPos + 9, eofIdx)).trim(),
      10
    );
    const dictEnd =
      trailerBuf.findLastIndex((_x, idx) =>
        testForString(trailerBuf, idx, '>>')
      ) + 2;
    const dictStart = trailerBuf.findLastIndex((_x, idx) =>
      testForString(trailerBuf, idx, '<<')
    );
    const trailerDict = new PdfValueParser(
      trailerBuf.subarray(dictStart, dictEnd)
    ).read() as PdfDictionary;
    for await (const { startNum, entries } of parseCrossRefSection(
      reader,
      xrefStartOffset,
      bufStart + dictEnd - xrefStartOffset
    )) {
      for (const [idx, [offset, gen, inUse]] of entries.entries()) {
        const objNum = idx + startNum;
        if ((objGenerations[objNum] ?? -1) > gen) {
          // Outdated entry, don't consider
          continue;
        }
        objGenerations[objNum] = gen;
        if (inUse) {
          objOffsets[objNum] = offset;
          objsDeleted[objNum] = false;
        } else {
          objOffsets[objNum] = -1;
          objsDeleted[objNum] = true;
        }
      }
    }
    if (objOffsets.length !== trailerDict.Size) {
      throw `Trailer dictionary has different number of objects than crossreference tables, ${objOffsets.length} vs. ${trailerDict.Size}`;
    }
    return new PdfParser(reader, objOffsets, objGenerations, trailerDict);
  }

  /** Private constructor, use factory method above. */
  private constructor(
    reader: Reader,
    objOffsets: Array<number>,
    objGenerations: Array<number>,
    trailerDict: PdfDictionary
  ) {
    this.reader = reader;
    this.objectOffsets = objOffsets;
    this.sortedOffsets = [...objOffsets].sort((a, b) => a - b);
    this.objGenerations = objGenerations;
    this.catalogNum = (trailerDict.Root as PdfRef).refObj;
    this.infoNum = (trailerDict.Info as PdfRef).refObj;
  }

  /** Retrieve the catalog dictionary. */
  async catalog(): Promise<PdfDictionary> {
    const obj = await this.getObject(this.catalogNum);
    if (!obj) {
      throw `Document has no catalog object (num as per trailer: ${this.catalogNum}!`;
    }
    return obj.data as PdfDictionary;
  }

  /** Retrieve the info dictionary. */
  async info(): Promise<PdfDictionary> {
    const obj = await this.getObject(this.infoNum);
    if (!obj) {
      throw `Document has no info object (num as per trailer: ${this.infoNum}!`;
    }
    return obj.data as PdfDictionary;
  }

  /** Yield all pages referenced in the given page dictionary. */
  async *_pagesFromPagesObj(
    pagesObj: PdfDictionary
  ): AsyncGenerator<PdfObject> {
    for (const pageRef of pagesObj.Kids as Array<PdfRef>) {
      const page = await this.getObject(pageRef.refObj, true);
      if (!page) {
        throw `Could not find Page object with number ${pageRef.refObj}`;
      }
      const pageDict = page.data as PdfDictionary;
      if (pageDict.Type === '/Pages') {
        yield* this._pagesFromPagesObj(pageDict);
      } else {
        yield page;
      }
    }
  }

  /** Yield all pages in the PDF. */
  async *pages(): AsyncGenerator<PdfObject> {
    const catalog = await this.catalog();
    const pagesRef = catalog.Pages as PdfRef;
    const pagesRoot = await this.getObject(pagesRef.refObj);
    if (!pagesRoot) {
      throw `Could not find Pages object with number ${pagesRef.refObj}`;
    }
    const pagesDict = pagesRoot.data as PdfDictionary;
    yield* this._pagesFromPagesObj(pagesDict);
  }

  /** Yield all annotations for the given page dictionary. */
  async *annotations(pageDict: PdfDictionary): AsyncGenerator<PdfDictionary> {
    const annots = pageDict.Annots;
    if (!annots) {
      return;
    }
    for (const annoRef of annots as Array<PdfRef>) {
      const anno = await this.getObject(annoRef.refObj);
      if (!anno) {
        throw `Could not find Annotation object with number ${annoRef.refObj}`;
      }
      yield anno.data as PdfDictionary;
    }
  }

  /** Resolve a PDF reference to the corresponding object. */
  resolveRef(ref: PdfRef): Promise<PdfObject | undefined> {
    return this.getObject(ref.refObj, true);
  }

  /** Get an object from the PDF from its number. */
  async getObject(
    num: number,
    withStream = false
  ): Promise<PdfObject | undefined> {
    const offset = this.objectOffsets[num];
    if (!offset) {
      return;
    }
    if (!this.pdfSize) {
      this.pdfSize = await this.reader.size();
    }
    const nextOffset =
      this.sortedOffsets[this.sortedOffsets.indexOf(offset) + 1] ??
      this.pdfSize;
    const buf = new Uint8Array(nextOffset - offset);
    await this.reader.read(buf, 0, offset, buf.length);
    const objEndIdx = buf.findIndex((_x, idx) =>
      testForString(buf, idx, 'endobj')
    );
    let streamIdx = buf.findIndex((_x, idx) =>
      testForString(buf, idx, 'stream')
    );
    if (streamIdx >= 0) {
      streamIdx += 'stream'.length;
      if (buf[streamIdx] === '\r'.charCodeAt(0)) {
        streamIdx += 2;
      } else {
        streamIdx += 1;
      }
    }
    const objSig = `${num} ${this.objGenerations[num]} obj`;
    const objParser = new PdfValueParser(
      buf.subarray(objSig.length, streamIdx < 0 ? objEndIdx : streamIdx)
    );
    const data = objParser.read();
    if (typeof data !== 'object' || data === null) {
      throw new Error('Illegal PDF object, does not start with a dictionary.');
    }
    let stream: Uint8Array | undefined;
    if (withStream && streamIdx > 0) {
      const streamLength = (data as PdfDictionary).Length as number | undefined;
      if (streamLength === undefined) {
        throw new Error(
          'Illegal stream object, missing Length entry in object dictionary.'
        );
      }
      stream = buf.subarray(streamIdx, streamIdx + streamLength);
    }
    return {
      num,
      data,
      stream,
    };
  }
}
