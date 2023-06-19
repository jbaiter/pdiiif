/** Types for writing to an output stream, with support for Node and Browsers. */
import type { Writable as NodeWritable } from 'stream';
import type nodeFs from 'fs';

import log from './log.js';

/** Base interface to be implemented by all readers.  */
export interface Reader {
  read(
    dst: Uint8Array,
    offset: number,
    position: number,
    length: number
  ): Promise<number>;
  size(): Promise<number>;
}

/** Base interface to be implemented by all writers. */
export interface Writer {
  /** Write a chunk to the writer */
  write(buffer: Uint8Array | string): Promise<void>;

  /** Close the writer */
  close(): Promise<void>;

  /** Wait for the next drainage/flush event */
  waitForDrain(): Promise<void>;
}

/** Reader implementation using the Web `File` API.  */
export class WebReader implements Reader {
  private file: File;

  constructor(file: File) {
    this.file = file;
  }

  async read(
    dst: Uint8Array,
    offset: number,
    position: number,
    length: number
  ): Promise<number> {
    const blob = this.file.slice(position, position + length);
    const buf = await blob.arrayBuffer();
    dst.set(new Uint8Array(buf), offset);
    return buf.byteLength;
  }

  size(): Promise<number> {
    return new Promise((resolve) => resolve(this.file.size));
  }
}

/** Wraps a writer and counts the bytes written to it. */
export class CountingWriter implements Writer {
  private _writer: Writer;
  bytesWritten = 0;

  constructor(writer: Writer) {
    this._writer = writer;
  }

  write(buffer: string | Uint8Array): Promise<void> {
    this.bytesWritten += buffer.length;
    return this._writer.write(buffer);
  }

  close(): Promise<void> {
    return this._writer.close();
  }

  waitForDrain(): Promise<void> {
    return this._writer.waitForDrain();
  }
}

/** A Writer implemented using the `File System Access API` available in
 *  recent Chrome, Edge and Opera browsers. */
export class WebWriter implements Writer {
  private _writer: WritableStreamDefaultWriter<any>;

  constructor(stream: WritableStream) {
    this._writer = stream.getWriter();
  }

  write(buffer: string | Uint8Array): Promise<void> {
    return this._writer.write(buffer);
  }

  waitForDrain(): Promise<void> {
    return this._writer.ready;
  }

  close(): Promise<void> {
    return this._writer.close();
  }
}


/** Writer implementation using the `Blob` API available in all browsers. */
export class BlobWriter implements Writer {
  // TODO: A good reference seems to be the mega.nz implementation, which has always worked great for me on desktops at least:
  // https://github.com/meganz/webclient/blob/f19289127b68ceaf19a5e884f2f48f15078304da/js/transfers/meths/memory.js
  private _parts: Array<Uint8Array | string>;
  private _blob?: Blob;

  constructor() {
    this._parts = [];
  }

  write(buffer: string | Uint8Array): Promise<void> {
    if (this._blob) {
      return Promise.reject('Cannot write to closed BlobWriter.');
    }
    this._parts.push(buffer);
    return Promise.resolve();
  }

  waitForDrain(): Promise<void> {
    if (this._blob) {
      return Promise.reject('Cannot wait on a closed BlobWriter.');
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this._blob) {
      return Promise.reject('BlobWriter is already closed');
    }
    this._blob = new Blob(this._parts);
    this._parts = [];
    return Promise.resolve();
  }

  get blob(): Blob {
    if (!this._blob) {
      throw 'BlobWriter must be closed first!';
    }
    return this._blob;
  }
}

/** Reader implentation using the node.js filesystem API. */
export class NodeReader implements Reader {
  private fileHandle: nodeFs.promises.FileHandle;

  constructor(handle: nodeFs.promises.FileHandle) {
    this.fileHandle = handle;
  }

  async read(
    dst: Uint8Array,
    offset: number,
    position: number,
    length: number
  ): Promise<number> {
    const { bytesRead } = await this.fileHandle.read(
      dst,
      offset,
      length,
      position
    );
    return bytesRead;
  }

  async size(): Promise<number> {
    const stat = await this.fileHandle.stat();
    return stat.size;
  }
}
/** Writer implementation using the node.js filesystem API. */
export class NodeWriter implements Writer {
  _writable: NodeWritable;
  _drainWaiters: Array<() => void> = [];

  constructor(writable: NodeWritable) {
    this._writable = writable;
    this._writable.on('drain', () => {
      log.debug('Drained writer.');
      for (const waiter of this._drainWaiters) {
        waiter();
      }
      this._drainWaiters = [];
    });
    this._writable.on('close', () => {
      for (const waiter of this._drainWaiters) {
        waiter();
      }
      this._drainWaiters = [];
    });
  }

  async write(buffer: string | Uint8Array): Promise<void> {
    let waitForDrain = false;
    const out = new Promise<void>((resolve, reject) => {
      if (!this._writable.writable) {
        reject('Cannot write to closed NodeWriter.');
      }
      waitForDrain = !this._writable.write(buffer, (err) =>
        err ? reject(err) : resolve()
      );
    });
    if (waitForDrain) {
      log.debug('Waiting for writer to drain');
      return await this.waitForDrain();
    } else {
      return await out;
    }
  }

  waitForDrain(): Promise<void> {
    return new Promise((resolve) => this._drainWaiters.push(resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this._writable.end(() => resolve()));
  }
}

/** Very basic Reader implementation using an Array. */
export class ArrayReader implements Reader {
  _buf: Uint8Array;

  constructor(buf: Uint8Array) {
    this._buf = buf;
  }

  read(
    dst: Uint8Array,
    offset: number,
    position: number,
    length: number
  ): Promise<number> {
    const sub = this._buf.subarray(position, position + length);
    dst.set(sub, offset);
    return Promise.resolve(sub.length);
  }

  size(): Promise<number> {
    return Promise.resolve(this._buf.length);
  }
}
