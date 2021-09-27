/* Based on the `images` modules in `pdfkit` by Devon Govett, licensed under MIT.
 *
 * Ported to TypeScript and modified to better fit a web use case, by using Pako instead
 * of zlib and Uint8Array instead of Buffer.
 *
 * https://github.com/foliojs/pdfkit/blob/master/lib/image/png.js
 * https://github.com/foliojs/pdfkit/blob/master/lib/image/png.js
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
import {
  PdfDictionary,
  serialize,
  PdfObject,
} from './pdf';
import {
  textDecoder,
  IS_BIG_ENDIAN,
} from './util';
import PNGDecoder from './png';
import Pako from 'pako';

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
    } else if (
      data[0] === 0x89 &&
      textDecoder.decode(data.slice(1, 4)) === 'PNG'
    ) {
      return new PNGImage(data);
    } else {
      throw new Error('Unknown image format.');
    }
  }

  abstract toObjects(startNum: number): Array<PdfObject>;
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

class PNGImage extends PdfImage {
  image: any;
  width: number;
  height: number;
  imgData: Uint8Array;
  alphaChannel?: Uint8Array;

  constructor(data: Uint8Array) {
    super();
    this.image = new PNGDecoder(data);
    this.width = this.image.width;
    this.height = this.image.height;
    this.imgData = this.image.imgData;
  }

  toObjects(startNum: number): Array<PdfObject> {
    let dataDecoded = false;

    const hasAlphaChannel = this.image.hasAlphaChannel;
    const isInterlaced = this.image.interlaceMethod === 1;

    const extraObjs: Array<PdfObject> = [];

    const obj: PdfDictionary = {
      Type: '/XObject',
      Subtype: '/Image',
      BitsPerComponent: hasAlphaChannel ? 8 : this.image.bits,
      Width: this.width,
      Height: this.height,
      Filter: '/FlateDecode',
    };

    if (!hasAlphaChannel) {
      obj.DecodeParams = {
        Predictor: isInterlaced ? 1 : 15,
        Colors: this.image.colors,
        BitsPerComponent: this.image.bits,
        Columns: this.width,
      };
    }

    if (this.image.palette.length === 0) {
      obj.ColorSpace = this.image.colorSpace;
    } else {
      // embed the color palette in the PDF as an object stream
      const paletteNum = startNum + 1;
      extraObjs.push({ num: paletteNum, stream: this.image.palette });

      // build the color space array for the image
      obj.ColorSpace = [
        'Indexed',
        'DeviceRGB',
        this.image.palette.length / 3 - 1,
        paletteNum,
      ];
    }

    // For PNG color types 0, 2 and 3, the transparency data is stored in
    // a dedicated PNG chunk.
    if (this.image.transparency.grayscale != null) {
      // Use Color Key Masking (spec section 4.8.5)
      // An array with N elements, where N is two times the number of color components.
      const val = this.image.transparency.grayscale;
      obj.Mask = [val, val];
    } else if (this.image.transparency.rgb) {
      // Use Color Key Masking (spec section 4.8.5)
      // An array with N elements, where N is two times the number of color components.
      const { rgb } = this.image.transparency;
      const mask = [];
      for (const x of rgb) {
        mask.push(x, x);
      }

      obj.Mask = mask;
    } else if (this.image.transparency.indexed) {
      // Create a transparency SMask for the image based on the data
      // in the PLTE and tRNS sections. See below for details on SMasks.
      dataDecoded = true;
      this.loadIndexedAlphaChannel();
    } else if (hasAlphaChannel) {
      // For PNG color types 4 and 6, the transparency data is stored as a alpha
      // channel mixed in with the main image data. Separate this data out into an
      // SMask object and store it separately in the PDF.
      dataDecoded = true;
      this.splitAlphaChannel();
    }

    if (isInterlaced && !dataDecoded) {
      this.decodeData();
    }

    if (this.alphaChannel) {
      const sMaskNum = startNum + extraObjs.length + 1;
      extraObjs.push({
        num: sMaskNum,
        data: {
          Type: '/XObject',
          Subtype: '/Image',
          Height: this.height,
          Width: this.width,
          BitsPerComponent: 8,
          Filter: '/FlateDecode',
          ColorSpace: '/DeviceGray',
          Decode: [0, 1],
        },
      });
      obj.SMask = `${sMaskNum} 0 R`;
    }
    obj.Length = this.imgData.length;
    return [{ num: startNum, data: obj, stream: this.imgData }, ...extraObjs];
  }

  splitAlphaChannel() {
    const pixels = this.image.decodePixels();
    let a, p;
    const colorCount = this.image.colors;
    const pixelCount = this.width * this.height;
    const imgData = new Uint8Array(pixelCount * colorCount);
    const alphaChannel = new Uint8Array(pixelCount);

    let i = (p = a = 0);
    const len = pixels.length;
    // For 16bit images copy only most significant byte (MSB) - PNG data is always stored in network byte order (MSB first)
    const skipByteCount = this.image.bits === 16 ? 1 : 0;
    while (i < len) {
      for (let colorIndex = 0; colorIndex < colorCount; colorIndex++) {
        imgData[p++] = pixels[i++];
        i += skipByteCount;
      }
      alphaChannel[a++] = pixels[i++];
      i += skipByteCount;
    }

    this.imgData = Pako.deflate(imgData);
    this.alphaChannel = Pako.deflate(alphaChannel);
    // return this.finalize();
  }

  loadIndexedAlphaChannel() {
    const transparency = this.image.transparency.indexed;
    const pixels = this.image.decodePixels();
    const alphaChannel = new Uint8Array(this.width * this.height);

    let i = 0;
    for (let j = 0, end = pixels.length; j < end; j++) {
      alphaChannel[i++] = transparency[pixels[j]];
    }

    this.alphaChannel = Pako.deflate(alphaChannel);
    //return this.finalize();
  }

  decodeData() {
    const pixels = this.image.decodePixels();
    this.imgData = Pako.deflate(pixels);
  }
}

export default PdfImage;
