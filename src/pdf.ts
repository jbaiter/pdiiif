/* eslint-disable no-new-wrappers */
/* eslint-disable @typescript-eslint/no-non-null-assertion */

/// PDF generation code
import PDFDocument from '@foliojs-fork/pdfkit';
import flatten from 'lodash/flatten';

const PRODUCER = 'pdiiif v0.1.0';

export default class PDFGenerator {
  doc?: PDFKit.PDFDocument;
  _bytesWritten: number | undefined = undefined;

  constructor(
    stream: NodeJS.WritableStream,
    metadata: PDFKit.DocumentInfo,
  ) {
    this.doc = new PDFDocument({
      info: {
        Producer: PRODUCER,
        ...metadata,
      },
      pdfVersion: '1.7',
      autoFirstPage: false,
      font: null,
    } as any);
    this.doc.pipe(stream);
  }

  setPageLabels(labels: string[]): void {
    if (!this.doc) {
      throw new Error(
        'PDFGenerator has already finished, cannot set page labels'
      );
    }
    const labelObj = this.doc?.ref({
      Nums: flatten(
        labels
          .map((label, idx) => [
            idx,
            label ? { P: new String(label) } : undefined,
          ])
          .filter(([, label]) => label !== undefined)
      ),
    });
    (this.doc._root.data as any).PageLabels = labelObj;
    labelObj.end(null);
  }

  renderPage(
    {
      width: canvasWidth,
      height: canvasHeight,
    }: { width: number; height: number },
    imgData: ArrayBuffer,
    ppi = 300,
  ): void {
    // Factor to multiply pixels by to get equivalent PDF units (72 pdf units === 1 inch)
    const unitScale = 72 / ppi;
    this._checkClosed(this.doc);
    this.doc!.addPage({
      margin: 0,
      size: [unitScale * canvasWidth, unitScale * canvasHeight],
    });
    this.doc!.image(imgData, 0, 0, {
      width: unitScale * canvasWidth,
      height: unitScale * canvasHeight,
    });
  }

  addTocItem(label: string, parent?: PDFKit.PDFOutline): PDFKit.PDFOutline {
    this._checkClosed(this.doc);
    if (parent) {
      return parent.addItem(label);
    }
    return this.doc!.outline.addItem(label);
  }

  bytesWritten(): number {
    return this.doc?._offset ?? this._bytesWritten ?? 0;
  }

  _checkClosed(doc?: PDFKit.PDFDocument): void {
    if (doc === undefined || doc === null) {
      throw new Error('Cannot perform mutating operations on an already closed PDFGenerator.');
    }
  }

  close(): void {
    this._checkClosed(this.doc);
    this.doc!.end();
    this._bytesWritten = this.doc!._offset;
    this.doc = undefined;
  }
}
