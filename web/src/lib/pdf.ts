"use client";

// PDFを開く（pdf.js）。日本語の文字の表（CMap）と標準のフォントを public/pdfjs/ から読むので、
// フォントの入っていない日本語のPDF（ネットバンキングの明細など）も、文字を読めて画像にもできる
export async function openPdf(data: ArrayBuffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
  return pdfjs.getDocument({ data: new Uint8Array(data), cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/" });
}
