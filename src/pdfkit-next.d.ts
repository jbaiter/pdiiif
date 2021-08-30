// Type definitions for Pdfkit v0.10.0
// Project: http://pdfkit.org
// Definitions by: Eric Hillah <https://github.com/erichillah>
//                 Erik Berreßem <https://github.com/she11sh0cked>
//                 Jeroen Vervaeke <https://github.com/jeroenvervaeke/>
//                 Thales Agapito <https://github.com/thalesagapito/>
//                 Evgeny Baram <https://github.com/r4tz52/>
//                 BamButz <https://github.com/BamButz/>
// Definitions: https://github.com/DefinitelyTyped/DefinitelyTyped

/// <reference types="node" />

declare module '@foliojs-fork/pdfkit/js/data' {
    const PDFKitData: PDFKit.PDFData;
    export = PDFKitData;
}

declare module '@foliojs-fork/pdfkit' {
    const doc: PDFKit.PDFDocument;
    export = doc;
}

declare module '@foliojs-fork/pdfkit/js/gradient' {
    const gradient: {
        PDFGradient: PDFKit.PDFGradient;
        PDFLinearGradient: PDFKit.PDFLinearGradient;
        PDFRadialGradiant: PDFKit.PDFRadialGradient;
    };

    export = gradient;
}

declare module '@foliojs-fork/pdfkit/js/page' {
    const PDFKitPage: PDFKit.PDFPage;

    export = PDFKitPage;
}

declare module '@foliojs-fork/pdfkit/js/reference' {
    const PDFKitReference: PDFKit.PDFKitReference;

    export = PDFKitReference;
}

declare module '@foliojs-fork/pdfkit/js/mixins/annotations' {
    const PDFKitAnnotation: PDFKit.Mixins.PDFAnnotation;
    export = PDFKitAnnotation;
}

declare module '@foliojs-fork/pdfkit/js/mixins/color' {
    const PDFKitColor: PDFKit.Mixins.PDFColor;
    export = PDFKitColor;
}

declare module '@foliojs-fork/pdfkit/js/mixins/fonts' {
    const PDFKitFont: PDFKit.Mixins.PDFFont;
    export = PDFKitFont;
}

declare module '@foliojs-fork/pdfkit/js/mixins/images' {
    const PDFKitImage: PDFKit.Mixins.PDFImage;
    export = PDFKitImage;
}

declare module '@foliojs-fork/pdfkit/js/mixins/text' {
    const PDFKitText: PDFKit.Mixins.PDFText;
    export = PDFKitText;
}

declare module '@foliojs-fork/pdfkit/js/mixins/vector' {
    const PDFKitVector: PDFKit.Mixins.PDFVector;
    export = PDFKitVector;
}
