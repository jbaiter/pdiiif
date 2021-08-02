import { PDFDocument } from 'pdf-lib';
import tmp from 'tmp';

import fs from 'fs';
import path from 'path';
import PDFGenerator from '../pdf';

describe('PDF generation', () => {
  it('should initialize a PDF with the correct metadata', async () => {
    const pdfPath = tmp.tmpNameSync({ postfix: '.pdf' });
    const pdfStream = fs.createWriteStream(pdfPath);
    const metadata = {
      Title: "Test Title",
    }; 
    const pdfgen = new PDFGenerator(pdfStream, metadata);
    const imgBuf = await fs.promises.readFile(
      path.resolve(__dirname, './fixtures/wunder.jpg'));
    pdfgen.renderPage({ width: 290, height: 400 }, imgBuf, 72);
    pdfgen.setPageLabels(['Test Label']);
    pdfgen.close();

    const pdfData = await fs.promises.readFile(pdfPath);
    const parsed = await PDFDocument.load(pdfData.buffer.slice(0));
    expect(parsed.getPageCount()).toBe(1);
    expect(parsed.getPage(0).getSize()).toMatchObject({ width: 290, height: 400 }); 
    expect(parsed.getTitle()).toBe('Test Title');
  });
});
