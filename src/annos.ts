import { Annotation, Canvas } from "manifesto.js";
import { PdfDictionary, PdfObject } from "./pdf/common";

export function fetchAllAnnotations(canvas: Canvas): Array<Annotation> {
    return [];
}

export function exportPdfAnnotation(anno: Annotation): Array<PdfDictionary> {
    return [];
}

export function importPdfAnnotation(pdfAnno: PdfDictionary): Annotation | undefined {
    return;
}