/**
 * Dependency-free image-to-PDF encoder.
 *
 * Two halves:
 * - `splitIntoPdfPages` decodes a capture and slices it into page-sized JPEG
 *   chunks using OffscreenCanvas (works in the service worker — no DOM).
 * - `generatePdf` assembles a minimal, spec-correct multi-page PDF by hand:
 *   catalog → pages → one Page + image XObject + content stream per page,
 *   then an xref table and trailer. Every object is a JPEG (DCTDecode), so no
 *   compression codec is needed — we only write bytes.
 */

/** One page of the output PDF: a JPEG-encoded image plus its pixel size. */
export interface PdfPage {
  /** JPEG-encoded page pixels. */
  imageBytes: Uint8Array<ArrayBuffer>;
  widthPx: number;
  heightPx: number;
}

/** Safety cap for a single page image in device pixels. */
const MAX_PAGE_HEIGHT_PX = 4000;
/** US Letter portrait in points (8.5 × 11 in). Every PDF page is this size. */
const LETTER_WIDTH_PT = 612;
const LETTER_HEIGHT_PT = 792;

export interface SplitOptions {
  maxPageHeightPx?: number;
  /** JPEG quality, 0-1. */
  quality?: number;
}

/**
 * Decode a PNG data URL and slice it into JPEG pages, top to bottom. Chunks
 * match the Letter aspect ratio so adjacent PDF pages form one continuous image
 * instead of independently scaled frames with large side margins.
 */
export async function splitIntoPdfPages(
  dataUrl: string,
  options: SplitOptions = {},
): Promise<PdfPage[]> {
  const { maxPageHeightPx = MAX_PAGE_HEIGHT_PX, quality = 0.92 } = options;
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const { width, height } = bitmap;
    const letterPageHeightPx = (width * LETTER_HEIGHT_PT) / LETTER_WIDTH_PT;
    const pageHeight = Math.max(1, Math.min(maxPageHeightPx, Math.floor(letterPageHeightPx)));
    const pages: PdfPage[] = [];
    for (let sourceY = 0; sourceY < height; sourceY += pageHeight) {
      const chunkHeight = Math.min(pageHeight, height - sourceY);
      const canvas = new OffscreenCanvas(width, chunkHeight);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas 2D is not available');
      // White underlay: JPEG has no alpha channel, so transparent pixels
      // would otherwise turn black.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, chunkHeight);
      ctx.drawImage(bitmap, 0, -sourceY);
      const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      pages.push({
        imageBytes: new Uint8Array(await jpeg.arrayBuffer()),
        widthPx: width,
        heightPx: chunkHeight,
      });
    }
    return pages;
  } finally {
    bitmap.close();
  }
}

export interface PdfPageOptions {
  /** Page size in points; defaults to US Letter portrait (612 × 792). */
  pageWidthPt?: number;
  pageHeightPt?: number;
}

/**
 * Assemble a minimal multi-page PDF from JPEG page images.
 *
 * Every page is a US Letter sheet and each image is drawn full-bleed across it. The
 * source is already split at the Letter aspect ratio, so page boundaries remain
 * continuous without margins or side whitespace.
 *
 * Object layout (N pages): 1 catalog, 2 page tree, then per page p:
 * 3p+3 Page, 3p+4 image XObject, 3p+5 content stream.
 */
export function generatePdf(pages: PdfPage[], options: PdfPageOptions = {}): Blob {
  const pageWidthPt = options.pageWidthPt ?? LETTER_WIDTH_PT;
  const pageHeightPt = options.pageHeightPt ?? LETTER_HEIGHT_PT;
  const out = new ByteWriter();
  const objectOffsets: number[] = [];

  out.ascii('%PDF-1.4\n');

  // 1: catalog → 2: page tree.
  objectOffsets.push(out.length);
  out.ascii('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  objectOffsets.push(out.length);
  out.ascii(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((page, i) => {
    const pageObj = 3 + i * 3;
    const imageObj = pageObj + 1;
    const contentObj = pageObj + 2;

    // Page object — every page is the same Letter MediaBox.
    objectOffsets.push(out.length);
    out.ascii(
      `${pageObj} 0 obj\n` +
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidthPt.toFixed(2)} ${pageHeightPt.toFixed(2)}] ` +
        `/Resources << /XObject << /Im${i} ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>\n` +
        `endobj\n`,
    );

    // Image XObject: JPEG bytes pass through verbatim (DCTDecode).
    objectOffsets.push(out.length);
    out.ascii(
      `${imageObj} 0 obj\n` +
        `<< /Type /XObject /Subtype /Image /Width ${page.widthPx} /Height ${page.heightPx} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.imageBytes.length} >>\n` +
        `stream\n`,
    );
    out.bytes(page.imageBytes);
    out.ascii('\nendstream\nendobj\n');

    // Content stream: fill the entire Letter page. The final slice may be scaled
    // vertically to avoid introducing a blank band below the capture.
    const content = `q ${pageWidthPt.toFixed(2)} 0 0 ${pageHeightPt.toFixed(2)} 0 0 cm /Im${i} Do Q`;
    objectOffsets.push(out.length);
    out.ascii(
      `${contentObj} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    );
  });

  // Cross-reference table + trailer. Offsets must point at "N 0 obj".
  const xrefOffset = out.length;
  out.ascii(`xref\n0 ${objectOffsets.length + 1}\n`);
  out.ascii('0000000000 65535 f \n');
  for (const offset of objectOffsets) {
    out.ascii(`${String(offset).padStart(10, '0')} 00000 n \n`);
  }
  out.ascii(
    `trailer\n<< /Size ${objectOffsets.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );

  return new Blob([out.toUint8Array()], { type: 'application/pdf' });
}

/** Growable byte accumulator that tracks the running length for xref offsets. */
class ByteWriter {
  private chunks: Uint8Array<ArrayBuffer>[] = [];
  private size = 0;

  get length(): number {
    return this.size;
  }

  bytes(value: Uint8Array<ArrayBuffer>): void {
    if (value.length === 0) return;
    this.chunks.push(value);
    this.size += value.length;
  }

  ascii(value: string): void {
    this.bytes(new TextEncoder().encode(value));
  }

  toUint8Array(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
