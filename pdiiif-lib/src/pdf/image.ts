/* Based on the `images` modules in `pdfkit` by Devon Govett, licensed under MIT.
 *
 * Ported to TypeScript and modified to better fit a web use case, by using Uint8Array
 * instead of Buffer.
 *
 * https://github.com/foliojs/pdfkit/blob/master/lib/image/jpeg.js
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
import { zlibSync } from 'fflate';
import { PdfDictionary, serialize, PdfObject, makeRef } from './common.js';
import PNG from './png.js';
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
    if (data.length > 2 && data[0] === 0xff && data[1] === 0xd8) {
      return new JPEGImage(data);
    } else if (
      data.length > 8 &&
      data[0] === 0x89 &&
      data[1] === 0x50 &&
      data[2] === 0x4e &&
      data[3] === 0x47 &&
      data[4] === 0x0d &&
      data[5] === 0x0a &&
      data[6] === 0x1a &&
      data[7] === 0x0a
    ) {
      return new PNGImage(data);
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

export class JPEGImage extends PdfImage {
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

export class PNGImage extends PdfImage {
  label: string | undefined;
  image: PNG;
  width: number;
  height: number;
  imgData: Uint8Array;

  constructor(data: Uint8Array, label?: string) {
    super();
    this.label = label;
    this.image = new PNG(data);
    this.width = this.image.width;
    this.height = this.image.height;
    this.imgData = this.image.imgData;
  }

  toObjects(startNum: number): Array<PdfObject> {
    let dataDecoded = false;

    const hasAlphaChannel = this.image.hasAlphaChannel;
    const isInterlaced = this.image.interlaceMethod === 1;

    const out: Array<PdfObject> = [];
    let nextNum = startNum;
    const imgObj: PdfObject = {
      num: nextNum++,
    };
    out.push(imgObj);

    const imgDict: PdfDictionary = {
      Type: '/XObject',
      Subtype: '/Image',
      BitsPerComponent: hasAlphaChannel ? 8 : this.image.bits,
      Width: this.width,
      Height: this.height,
      Filter: '/FlateDecode',
    };

    if (!hasAlphaChannel) {
      imgDict.DecodeParms = {
        Predictor: isInterlaced ? 1 : 15,
        Colors: this.image.colors,
        BitsPerComponent: this.image.bits,
        Columns: this.width,
      };
    }

    if (this.image.palette.length === 0) {
      imgDict.ColorSpace = `/${this.image.colorSpace}`;
    } else {
      // embed the color palette in the PDF as an object stream
      const paletteObj: PdfObject = {
        num: nextNum++,
        data: serialize({ Length: this.image.palette.length }),
        stream: new Uint8Array(this.image.palette),
      };
      out.push(paletteObj);
      // build the color space array for the image
      imgDict.ColorSpace = [
        '/Indexed',
        '/DeviceRGB',
        this.image.palette.length / 3 - 1,
        makeRef(paletteObj),
      ];
    }

    // For PNG color types 0, 2 and 3, the transparency data is stored in
    // a dedicated PNG chunk.
    if (this.image.transparency.grayscale != null) {
      // Use Color Key Masking (spec section 4.8.5)
      // An array with N elements, where N is two times the number of color components.
      const val = this.image.transparency.grayscale;
      imgDict.Mask = [val, val];
    } else if (this.image.transparency.rgb) {
      // Use Color Key Masking (spec section 4.8.5)
      // An array with N elements, where N is two times the number of color components.
      const { rgb } = this.image.transparency;
      const mask = [];
      for (let x of rgb) {
        mask.push(x, x);
      }

      imgDict.Mask = mask;
    } else if (this.image.transparency.indexed) {
      // Create a transparency SMask for the image based on the data
      // in the PLTE and tRNS sections. See below for details on SMasks.
      const alphaChannelObj = this.loadIndexedAlphaChannel(nextNum++);
      imgDict.SMask = makeRef(alphaChannelObj);
      out.push(alphaChannelObj);
      dataDecoded = true;
    } else if (hasAlphaChannel) {
      // For PNG color types 4 and 6, the transparency data is stored as a alpha
      // channel mixed in with the main image data. Separate this data out into an
      // SMask object and store it separately in the PDF.
      const [imageData, alphaChannelObj] = this.splitAlphaChannel(nextNum++);
      imgObj.stream = zlibSync(imageData);
      imgDict.Length = imgObj.stream.length;
      imgDict.SMask = makeRef(alphaChannelObj);
      out.push(alphaChannelObj);
    }

    if (isInterlaced && !dataDecoded && !imgObj.stream) {
      imgObj.stream = zlibSync(this.image.decodePixels());
      imgDict.Length = imgObj.stream.length;
    } else if (!imgObj.stream) {
      imgObj.stream = this.imgData;
      imgDict.Length = imgObj.stream.length;
    }

    imgObj.data = serialize(imgDict);

    if (out.length < 3) {
      // Add empty dummy objects until we have 3 objects for the image, to stay true
      // to our pre-determined object numbering
      for (let i = out.length; i < 3; i++) {
        out.push({ num: nextNum++ });
      }
    }
    return out;
  }

  splitAlphaChannel(objNum: number): [Uint8Array, PdfObject] {
    const pixels = this.image.decodePixels();
    const colorCount = this.image.colors;
    const pixelCount = this.width * this.height;
    const imgData = new Uint8Array(pixelCount * colorCount);
    const alphaChannel = new Uint8Array(pixelCount);

    let i = 0;
    let a = 0;
    let p = 0;
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

    const alphaChannelDeflated = zlibSync(alphaChannel);
    return [
      imgData,
      {
        num: objNum,
        data: serialize({
          Type: '/XObject',
          Subtype: '/Image',
          Width: this.width,
          Height: this.height,
          BitsPerComponent: 8,
          Decode: [0, 1],
          ColorSpace: '/DeviceGray',
          Filter: '/FlateDecode',
          Length: alphaChannelDeflated.length,
        }),
        stream: alphaChannelDeflated,
      },
    ];
  }

  loadIndexedAlphaChannel(objNum: number): PdfObject {
    const pixels = this.image.decodePixels();
    const transparency = this.image.transparency.indexed!;
    const alphaChannel = new Uint8Array(this.width * this.height);

    let i = 0;
    for (let j = 0, end = pixels.length; j < end; j++) {
      alphaChannel[i++] = transparency[pixels[j]];
    }

    const alphaChannelDeflated = zlibSync(alphaChannel);
    return {
      num: objNum,
      data: serialize({
        Type: '/XObject',
        Subtype: '/Image',
        Width: this.width,
        Height: this.height,
        BitsPerComponent: 8,
        Decode: [0, 1],
        ColorSpace: '/DeviceGray',
        Filter: '/FlateDecode',
        Length: alphaChannelDeflated.length,
      }),
      stream: alphaChannelDeflated,
    };
  }
}

export default PdfImage;
