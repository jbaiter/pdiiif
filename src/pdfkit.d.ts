/* eslint-disable @typescript-eslint/no-misused-new */
declare namespace PDFKit {
  interface PDFOutline {
    new(
      document: PDFKit.PDFDocument,
      parent?: PDFKit.PDFKitReference,
      title?: string,
      dest?: PDFKit.PDFPage,
      options?: { expanded?: boolean }
    ): PDFOutline;

    addItem(title: string, options?: { expanded?: boolean }): PDFOutline;

    endOutline(): void;
  }

  interface PDFDocument {
    outline: PDFOutline;
    // TODO: Should be `Font` from `fontkit`, how do you import in d.ts?
    _font: any;

    _root: PDFKit.PDFKitReference;
  }
}
