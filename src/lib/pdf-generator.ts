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

/** Tall captures are split so no page exceeds this height in device pixels. */
const MAX_PAGE_HEIGHT_PX = 2000;
/** PDF unit conversion: 1 CSS/device px = 0.75 pt. */
const PX_TO_PT = 0.75;

export interface SplitOptions {
  maxPageHeightPx?: number;
  /** JPEG quality, 0-1. */
  quality?: number;
}

/**
 * Decode a PNG data URL and slice it into JPEG pages, top to bottom.
 * A capture taller than `maxPageHeightPx` becomes one PDF page per chunk.
 */
export async function splitIntoPdfPages(
  dataUrl: string,
  options: SplitOptions = {},
): Promise<PdfPage[]> {
  const { maxPageHeightPx = MAX_PAGE_HEIGHT_PX, quality = 0.92 } = options;
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const { width, height } = bitmap;
    const pageCount = Math.max(1, Math.ceil(height / maxPageHeightPx));
    const pageHeight = Math.ceil(height / pageCount);
    const pages: PdfPage[] = [];
    for (let i = 0; i < pageCount; i++) {
      const canvas = new OffscreenCanvas(width, pageHeight);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas 2D is not available');
      // White underlay: JPEG has no alpha channel, so transparent pixels
      // would otherwise turn black.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, pageHeight);
      ctx.drawImage(bitmap, 0, -i * pageHeight);
      const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      pages.push({
        imageBytes: new Uint8Array(await jpeg.arrayBuffer()),
        widthPx: width,
        heightPx: pageHeight,
      });
    }
    return pages;
  } finally {
    bitmap.close();
  }
}

/**
 * Assemble a minimal multi-page PDF from JPEG page images.
 *
 * Object layout (N pages): 1 catalog, 2 page tree, then per page p:
 * 3p+3 Page, 3p+4 image XObject, 3p+5 content stream.
 */
export function generatePdf(pages: PdfPage[]): Blob {
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
    const widthPt = pt(page.widthPx);
    const heightPt = pt(page.heightPx);

    // Page object. The content stream scales the unit image to the full page.
    objectOffsets.push(out.length);
    out.ascii(
      `${pageObj} 0 obj\n` +
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] ` +
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

    // Content stream: `q w 0 0 h 0 0 cm /ImN Do Q` draws ImN scaled to w×h pt.
    const content = `q ${widthPt} 0 0 ${heightPt} 0 0 cm /Im${i} Do Q`;
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

/** Format a point value with two decimal places (PDF numbers). */
function pt(pixels: number): string {
  return (pixels * PX_TO_PT).toFixed(2);
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
