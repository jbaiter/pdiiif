/// <reference types="wicg-file-system-access"/>
/// <reference types="node"/>

import 'stream';
import type { WritableOptions } from 'stream';
import { Writable } from 'stream';

/** Wrap a {@link FileSystemWritableFileStream} so it can be used as
 *  a {@link Writable} for node.js APIs. */
export class WritableAdapter extends Writable {
  _webStream: FileSystemWritableFileStream;

  constructor(
    webStream: FileSystemWritableFileStream,
    options?: WritableOptions
  ) {
    super(options);
    this._webStream = webStream;
  }

  _write(chunk: any, enc: string, cb: (error?: Error | null) => void) {
    this._webStream
      .write(chunk as FileSystemWriteChunkType)
      .then(() => cb())
      .catch((reason) => {
        cb(reason);
      });
  }

  _destroy(error: Error | null, cb: (error: Error | null) => void): void {
    this._webStream
      .close()
      .then(() => cb(null))
      .catch((reason) => {
        try {
          cb(reason);
        } catch {
          // Sometimes the error callback was already called, just log in that case
          console.error(reason);
        }
      });
  }

  _final(cb: (error?: Error | null) => void): void {
    try {
      this._webStream
        .close()
        .then(() => {
          this.emit('close');
          cb(null);
        })
        .catch((reason) => cb(reason));
    } catch (err) {
      cb(err as Error | null);
    }
  }
}
