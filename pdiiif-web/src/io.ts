import streamSaver from 'streamsaver';

/** Wrapper around streamsaver to work around a bug.
 *
 * See docstring on `getWriter` for details.
 */
export class KeepAliveStreamSaver {
  private _streamSaver: WritableStream<Uint8Array>;

  constructor(fileName: string) {
    this._streamSaver = streamSaver.createWriteStream(fileName);
  }

  close(): Promise<void> {
    return this._streamSaver.close();
  }

  /** Returns a writer that, if no writes happen for a given time, will
   *  write a whitespace character to the stream. This is to work around
   *  a bug (?) in streamsaver.js which will close a stream with no
   *  indication to the caller if no writes happen within a certain time
   *  frame (I think it's 30 seconds), at least in recent Firefox versions.
   *  Since the application will write to the stream in chunks of individual
   *  PDF Objects, and since inter-object whitespace is not structurally
   *  relevant in PDF, this should be safe to do.
   */
  getWriter(): WritableStreamDefaultWriter<Uint8Array> {
    const writer = this._streamSaver.getWriter();
    let lastWrite = window.performance.now();
    const heartbeat = setInterval(() => {
      const timestamp = window.performance.now();
      if (writer.closed) {
        clearInterval(heartbeat);
      }
      if (timestamp - lastWrite > (20 * 1000 /* 20 seconds */)) {
        navigator.locks.request('streamsaver-write', () => {
          console.debug('💓');
          writer.write(new Uint8Array([0x20]));
        });
      }
    }, 1000);

    return {
      get closed(): Promise<undefined> {
        return writer.closed;
      },
      get desiredSize(): number | null {
        return writer.desiredSize;
      },
      get ready(): Promise<undefined> {
        return writer.ready;
      },
      abort(reason?: any): Promise<void> {
        return writer.abort(reason);
      },
      close(): Promise<void> {
        return writer.close();
      },
      releaseLock(): void {
        return writer.releaseLock();
      },
      write(chunk?: Uint8Array): Promise<void> {
        return new Promise((resolve) =>
          navigator.locks.request('streamsaver-write', async () => {
            await writer.write(chunk);
            lastWrite = window.performance.now();
            resolve();
          })
        );
      },
    };
  }

  abort(reason?: any): Promise<void> {
    return this._streamSaver.abort(reason);
  }

  get locked() {
    return this._streamSaver.locked;
  }
}
