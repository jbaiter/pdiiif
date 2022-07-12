/* Based on the `images` modules in `pdfkit` by Devon Govett, licensed under MIT.
 *
 * Ported to TypeScript and modified to better fit a web use case, by using  Uint8Array
 * instead of Buffer.
 *
 * https://github.com/foliojs/pdfkit/blob/master/lib/image/jpeg.js
 *
 * MIT LICENSE
 * Copyright (c) 2011 Devon Govett
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
 * to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { PdfDictionary, serialize, PdfObject } from './common.js';
import { IS_BIG_ENDIAN } from './util.js';

function readUint16BE(buf: Uint8Array, pos = 0): number {
  const val = new Uint16Array(buf.slice(pos, pos + 2).buffer)[0];
  if (IS_BIG_ENDIAN) {
    return val;
  } else {
    // system is little endian, swap bytes in value from buffer
    return ((val & 0xff) << 8) | ((val >> 8) & 0xff);
  }
}

abstract class PdfImage {
  static open(data: Uint8Array): PdfImage {
    if (data[0] === 0xff && data[1] === 0xd8) {
      return new JPEGImage(data);
    } else {
      throw new Error('Unknown image format.');
    }
  }

  abstract toObjects(
    startNum: number,
    isOptional?: boolean,
    optionalTitle?: string,
    optionalDefaultState?: boolean
  ): Array<PdfObject>;
}

class JPEGImage extends PdfImage {
  static MARKERS = [
    0xffc0, 0xffc1, 0xffc2, 0xffc3, 0xffc5, 0xffc6, 0xffc7, 0xffc8, 0xffc9,
    0xffca, 0xffcb, 0xffcc, 0xffcd, 0xffce, 0xffcf,
  ];
  static COLOR_SPACE_MAP = {
    1: 'DeviceGray',
    3: 'DeviceRGB',
    4: 'DeviceCMYK',
  };
  data: Uint8Array;

  bits: number;
  width: number;
  height: number;
  colorSpace: string;

  constructor(data: Uint8Array) {
    super();
    let marker;
    this.data = data;
    if (readUint16BE(this.data, 0) !== 0xffd8) {
      throw 'SOI not found in JPEG';
    }

    let pos = 2;
    while (pos < this.data.length) {
      marker = readUint16BE(this.data, pos);
      pos += 2;
      if (JPEGImage.MARKERS.includes(marker)) {
        break;
      }
      pos += readUint16BE(this.data, pos);
    }

    if (!marker || !JPEGImage.MARKERS.includes(marker)) {
      throw 'Invalid JPEG.';
    }
    pos += 2;

    this.bits = this.data[pos++];
    this.height = readUint16BE(this.data, pos);
    pos += 2;

    this.width = readUint16BE(this.data, pos);
    pos += 2;

    const channels = this.data[pos++];
    if ([1, 3, 4].indexOf(channels) < 0) {
      throw 'Bad number of channels, only 1, 3 or 4 are supported';
    }
    this.colorSpace = JPEGImage.COLOR_SPACE_MAP[channels as 1 | 3 | 4];
  }

  toObjects(startNum: number): Array<PdfObject> {
    const obj: PdfDictionary = {
      Type: '/XObject',
      Subtype: '/Image',
      BitsPerComponent: this.bits,
      Width: this.width,
      Height: this.height,
      ColorSpace: `/${this.colorSpace}`,
      Filter: '/DCTDecode',
      Length: this.data.length,
    };

    // add extra decode params for CMYK images. By swapping the
    // min and max values from the default, we invert the colors. See
    // section 4.8.4 of the spec.
    if (this.colorSpace === 'DeviceCMYK') {
      obj.Decode = [1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0];
    }
    return [{ num: startNum, data: serialize(obj), stream: this.data }];
  }
}

export default PdfImage;
