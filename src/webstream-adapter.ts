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

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  _write(chunk: any, enc: string, cb: (error?: Error | null) => void): void  {
    this._webStream
      .write(chunk as FileSystemWriteChunkType)
      .then(() => cb())
      .catch((reason) => {
        cb(reason)
      });
  }

  _destroy(error: Error | null, cb: (error: Error | null) => void): void {
    this._webStream
      .close()
      .then(() => cb(null))
      .catch((reason) => cb(reason));
  }

  _final(cb: (error?: Error | null) => void): void {
    this._webStream
      .close()
      .then(() => {
        console.log('Emitting close signal from adapter');
        cb(null)
      })
      .catch(() => {
        // NOP
      })
      .finally(() => {
        this.emit('close');
      });
  }
}
