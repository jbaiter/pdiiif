/* Based on `png-js` by Devon Govett with the following modifications:
 * - Added TypeScript type hints
 * - Use Uint8Array as the buffer type throughout
 * - Use pako instead of zlib for decompression
 * - Remove any APIs and related code that isn't used for embedding
 *   in PDFs (most prominently animations)
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

import Pako from "pako";

export default class PNG {
  data: Uint8Array;
  pos: number;
  palette?: Uint8Array;
  imgData?: Uint8Array;
  transparency: {
    indexed?: Uint8Array;
    rgb?: Uint8Array;
    grayscale?: number;
  }

  width = 0;
  height = 0;
  bits?: number;
  colorType?: number;
  interlaceMethod?: number;
  colors?: 1 | 3;
  hasAlphaChannel = false;
  pixelBitlength = 0;
  colorSpace?: 'DeviceGray' | 'DeviceRGB';

  _decodedPalette?: Uint8Array;


  constructor(data1: Uint8Array) {
    let i;
    this.data = data1;
    this.pos = 8; // Skip the default header

    this.palette; // NEEDED
    this.imgData; // NEEDED
    this.transparency = {}; // NEEDED

    const imgDataChunks: Array<Uint8Array> = [];
    while (this.pos < this.data.length) {
      let buf: Uint8Array;
      const chunkSize = this.readUInt32();
      let section = '';
      for (i = 0; i < 4; i++) {
        section += String.fromCharCode(this.data[this.pos++]);
      }

      switch (section) {
        case 'IHDR':
          // we can grab  interesting values from here (like width, height, etc)
          this.width = this.readUInt32(); // NEEDED
          this.height = this.readUInt32();  // NEEDED
          this.bits = this.data[this.pos++]; // NEEDED
          this.colorType = this.data[this.pos++];
          this.interlaceMethod = this.data[this.pos++]; // NEEDED
          break;

        case 'PLTE':
          this.palette = this.read(chunkSize);
          break;

        case 'IDAT':
          imgDataChunks.push(this.data.slice(this.pos, this.pos + chunkSize));
          this.pos += chunkSize;
          break;

        case 'tRNS':
          // This chunk can only occur once and it must occur after the
          // PLTE chunk and before the IDAT chunk.
          this.transparency = {};
          switch (this.colorType) {
            case 3:
              // Indexed color, RGB. Each byte in this chunk is an alpha for
              // the palette index in the PLTE ("palette") chunk up until the
              // last non-opaque entry. Set up an array, stretching over all
              // palette entries which will be 0 (opaque) or 1 (transparent).
              this.transparency.indexed = new Uint8Array(255);
              buf = this.read(chunkSize);
              this.transparency.indexed.set(buf, 0);
              if (buf.length < 255) {
                for (i = buf.length; i < 255; i++) {
                  this.transparency.indexed[i] = 255;
                }
              }
              break;
            case 0:
              // Greyscale. Corresponding to entries in the PLTE chunk.
              // Grey is two bytes, range 0 .. (2 ^ bit-depth) - 1
              this.transparency.grayscale = this.read(chunkSize)[0];
              break;
            case 2:
              // True color with proper alpha channel.
              this.transparency.rgb = this.read(chunkSize);
              break;
          }
          break;

        case 'IEND':
          // we've got everything we need!
          // NEEDED
          switch (this.colorType) {
            case 0:
            case 3:
            case 4:
              this.colors = 1;
              break;
            case 2:
            case 6:
              this.colors = 3;
              break;
          }

          // NEEDED
          this.hasAlphaChannel = [4, 6].includes(this.colorType ?? 0);
          {
            const colors = (this.colors ?? 0) + (this.hasAlphaChannel ? 1 : 0);
            this.pixelBitlength = (this.bits ?? 0) * colors;
          }

          // NEEDED
          switch (this.colors) {
            case 1:
              this.colorSpace = 'DeviceGray';
              break;
            case 3:
              this.colorSpace = 'DeviceRGB';
              break;
          }

          this.imgData = new Uint8Array(imgDataChunks.reduce((len, c) => len + c.length, 0));
          {
            let offset = 0;
            for (const chunk of imgDataChunks) {
              this.imgData.set(chunk, offset);
              offset += chunk.length;
            }
          }

          return;
        default:
          // unknown (or unimportant) section, skip it
          this.pos += chunkSize;
      }

      this.pos += 4; // Skip the CRC

      if (this.pos > this.data.length) {
        throw new Error('Incomplete or corrupt PNG file');
      }
    }
  }

  read(numBytes: number): Uint8Array {
    const data = this.data.slice(this.pos, this.pos + numBytes);
    this.pos += numBytes;
    return data;
  }

  readUInt32(): number {
    const b1 = this.data[this.pos++] << 24;
    const b2 = this.data[this.pos++] << 16;
    const b3 = this.data[this.pos++] << 8;
    const b4 = this.data[this.pos++];
    return b1 | b2 | b3 | b4;
  }

  readUInt16(): number {
    const b1 = this.data[this.pos++] << 8;
    const b2 = this.data[this.pos++];
    return b1 | b2;
  }

  // NEEDED
  decodePixels(data?: Uint8Array): Uint8Array {
    if (data == undefined) {
      data = this.imgData ?? new Uint8Array(0);
    }
    if (data.length === 0) {
      return new Uint8Array(0);
    }

    data = Pako.deflate(data);
    if (data === undefined) {
      throw 'Could not decompress image data';
    }

    const { width, height } = this;
    const pixelBytes = this.pixelBitlength / 8;

    const pixels = new Uint8Array(width * height * pixelBytes);
    const { length } = data;
    let pos = 0;

    function pass(x0: number, y0: number, dx: number, dy: number, singlePass = false): void {
      const w = Math.ceil((width - x0) / dx);
      const h = Math.ceil((height - y0) / dy);
      const scanlineLength = pixelBytes * w;
      const buffer = singlePass ? pixels : new Uint8Array(scanlineLength * h);
      let row = 0;
      let c = 0;
      while (row < h && pos < length) {
        let byte = 0;
        let col = 0;
        let i = 0;
        let left = 0;
        let upper = 0;
        switch (data?.[pos++]) {
          case 0: // None
            for (i = 0; i < scanlineLength; i++) {
              buffer[c++] = data[pos++];
            }
            break;

          case 1: // Sub
            for (i = 0; i < scanlineLength; i++) {
              byte = data[pos++];
              left = i < pixelBytes ? 0 : buffer[c - pixelBytes];
              buffer[c++] = (byte + left) % 256;
            }
            break;

          case 2: // Up
            for (i = 0; i < scanlineLength; i++) {
              byte = data[pos++];
              col = (i - (i % pixelBytes)) / pixelBytes;
              upper =
                row &&
                buffer[
                  (row - 1) * scanlineLength +
                    col * pixelBytes +
                    (i % pixelBytes)
                ];
              buffer[c++] = (upper + byte) % 256;
            }
            break;

          case 3: // Average
            for (i = 0; i < scanlineLength; i++) {
              byte = data[pos++];
              col = (i - (i % pixelBytes)) / pixelBytes;
              left = i < pixelBytes ? 0 : buffer[c - pixelBytes];
              upper =
                row &&
                buffer[
                  (row - 1) * scanlineLength +
                    col * pixelBytes +
                    (i % pixelBytes)
                ];
              buffer[c++] = (byte + Math.floor((left + upper) / 2)) % 256;
            }
            break;

          case 4: // Paeth
            for (i = 0; i < scanlineLength; i++) {
              let paeth, upperLeft;
              byte = data[pos++];
              col = (i - (i % pixelBytes)) / pixelBytes;
              left = i < pixelBytes ? 0 : buffer[c - pixelBytes];

              if (row === 0) {
                upper = upperLeft = 0;
              } else {
                upper =
                  buffer[
                    (row - 1) * scanlineLength +
                      col * pixelBytes +
                      (i % pixelBytes)
                  ];
                upperLeft =
                  col &&
                  buffer[
                    (row - 1) * scanlineLength +
                      (col - 1) * pixelBytes +
                      (i % pixelBytes)
                  ];
              }

              const p = left + upper - upperLeft;
              const pa = Math.abs(p - left);
              const pb = Math.abs(p - upper);
              const pc = Math.abs(p - upperLeft);

              if (pa <= pb && pa <= pc) {
                paeth = left;
              } else if (pb <= pc) {
                paeth = upper;
              } else {
                paeth = upperLeft;
              }

              buffer[c++] = (byte + paeth) % 256;
            }
            break;

          default:
            throw new Error(`Invalid filter algorithm: ${data?.[pos - 1]}`);
        }

        if (!singlePass) {
          let pixelsPos = ((y0 + row * dy) * width + x0) * pixelBytes;
          let bufferPos = row * scanlineLength;
          for (i = 0; i < w; i++) {
            for (let j = 0; j < pixelBytes; j++)
              pixels[pixelsPos++] = buffer[bufferPos++];
            pixelsPos += (dx - 1) * pixelBytes;
          }
        }

        row++;
      }
    }

    if (this.interlaceMethod === 1) {
      /*
        1 6 4 6 2 6 4 6
        7 7 7 7 7 7 7 7
        5 6 5 6 5 6 5 6
        7 7 7 7 7 7 7 7
        3 6 4 6 3 6 4 6
        7 7 7 7 7 7 7 7
        5 6 5 6 5 6 5 6
        7 7 7 7 7 7 7 7
      */
      pass(0, 0, 8, 8); // 1
      pass(4, 0, 8, 8); // 2
      pass(0, 4, 4, 8); // 3
      pass(2, 0, 4, 4); // 4
      pass(0, 2, 2, 4); // 5
      pass(1, 0, 2, 2); // 6
      pass(0, 1, 1, 2); // 7
    } else {
      pass(0, 0, 1, 1, true);
    }

    return pixels;
  }

  decodePalette(): Uint8Array {
    const { palette } = this;
    if (!palette) {
      throw 'No palette in file!';
    }
    const { length } = palette;
    const transparency = this.transparency.indexed || [];
    const ret = new Uint8Array((transparency.length || 0) + length);
    let pos = 0;
    let c = 0;

    for (let i = 0; i < length; i += 3) {
      let left;
      ret[pos++] = palette[i];
      ret[pos++] = palette[i + 1];
      ret[pos++] = palette[i + 2];
      ret[pos++] = (left = transparency[c++]) != null ? left : 255;
    }

    return ret;
  }

  copyToImageData(imageData: Uint8Array | ImageData, pixels: Uint8Array): void {
    let j, k;
    let palette = null;
    let alpha = this.hasAlphaChannel;
    let numColors: number = this.colors ?? 0;

    if (this.palette?.length) {
      palette =
        this._decodedPalette || (this._decodedPalette = this.decodePalette());
      numColors = 4;
      alpha = true;
    }

    const data = imageData instanceof ImageData
      ? imageData.data
      : imageData;
    const { length } = data;
    const input = palette || pixels;
    let i = (j = 0);

    if (numColors === 1) {
      while (i < length) {
        k = palette ? pixels[i / 4] * 4 : j;
        const v = input[k++];
        data[i++] = v;
        data[i++] = v;
        data[i++] = v;
        data[i++] = alpha ? input[k++] : 255;
        j = k;
      }
    } else {
      while (i < length) {
        k = palette ? pixels[i / 4] * 4 : j;
        data[i++] = input[k++];
        data[i++] = input[k++];
        data[i++] = input[k++];
        data[i++] = alpha ? input[k++] : 255;
        j = k;
      }
    }
  }

  decode(): Uint8Array {
    const ret = new Uint8Array(this.width * this.height * 4);
    this.copyToImageData(ret, this.decodePixels());
    return ret;
  }

  render(canvas: HTMLCanvasElement): void {
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw 'Could not create 2D context on canvas';
    }

    const data = ctx.createImageData(this.width, this.height);
    this.copyToImageData(data, this.decodePixels());
    return ctx.putImageData(data, 0, 0);
  }
}