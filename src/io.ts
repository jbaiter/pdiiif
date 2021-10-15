/** Types for writing to an output stream, with support for Node and Browsers. */
import type { Writable as NodeWritable } from 'stream';
import type nodeFs from 'fs';

export interface Reader {
  read(dst: Uint8Array, offset: number, position: number, length: number): Promise<number>;
  size(): Promise<number>;
}

export interface Writer {
  /** Write a chunk to the writer */
  write(buffer: Uint8Array | string): Promise<void>;

  /** Close the writer */
  close(): Promise<void>;

  /** Wait for the next drainage/flush event */
  waitForDrain(): Promise<void>;
}

export class WebReader implements Reader {
  private file: File;

  constructor(file: File) {
    this.file = file;
  }

  async read(dst: Uint8Array, offset: number, position: number, length: number): Promise<number> {
    const blob = this.file.slice(position, position + length);
    const buf = await blob.arrayBuffer();
    dst.set(new Uint8Array(buf), offset);
    return buf.byteLength; 
  }

  size(): Promise<number> {
    return new Promise(resolve => resolve(this.file.size));
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

/** A Writer that can be used with e.g. a file system stream in the browser. */
export class WebWriter implements Writer {
  private _stream: WritableStream;
  private _writer: WritableStreamDefaultWriter<any>;

  constructor(stream: WritableStream) {
    this._stream = stream;
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

export class NodeReader implements Reader {
  private fileHandle: nodeFs.promises.FileHandle;

  constructor(handle: nodeFs.promises.FileHandle) {
    this.fileHandle = handle;
  }

  async read(dst: Uint8Array, offset: number, position: number, length: number): Promise<number> {
    const { bytesRead } = await this.fileHandle.read(dst, offset, length, position);
    return bytesRead;
  }

  async size(): Promise<number> {
    const stat = await this.fileHandle.stat();
    return stat.size;
  }
}
/** Adapter for Node.js writable streams. */
export class NodeWriter implements Writer {
  _writable: NodeWritable;
  _drainWaiters: Array<() => void> = [];

  constructor(writable: NodeWritable) {
    this._writable = writable;
    this._writable.on('drain', () => {
      for (const waiter of this._drainWaiters) {
        waiter();
      }
      this._drainWaiters = [];
    })
  }

  write(buffer: string | Uint8Array): Promise<void> {
    let waitForDrain = false;
    const out = new Promise<void>(
      (resolve, reject) =>
        (waitForDrain = this._writable.write(buffer, (err) =>
          err ? reject(err) : resolve()
        ))
    );
    if (waitForDrain) {
      return this.waitForDrain();
    } else {
      return out;
    }
  }

  waitForDrain(): Promise<void> {
    return new Promise((resolve) => this._drainWaiters.push(resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this._writable.end(() => resolve()));
  }
}
