import jsPDF from 'jspdf';

/** Modern Fintech brand colors for PDF exports (RGB) */
export const PDF = {
  navy: [11, 31, 58] as [number, number, number],
  teal: [13, 148, 136] as [number, number, number],
  white: [255, 255, 255] as [number, number, number],
  slate: [100, 116, 139] as [number, number, number],
  slateLight: [248, 250, 252] as [number, number, number],
  slateBorder: [226, 232, 240] as [number, number, number]
} as const;

/**
 * Aurora header palette (RGB) — mirrors `print-report-aurora-header.html`.
 * The report BODY stays light/print-safe (see {@link pdfTableStyles}); only the
 * branded header band uses these dark/gradient tokens.
 */
export const AURORA = {
  /** Header band gradient stops: #12132A (top) → #0A0B1A (bottom). */
  bandTop: [18, 19, 42] as [number, number, number],
  bandBottom: [10, 11, 26] as [number, number, number],
  /** Gradient rule stops: violet → blue → teal. */
  violet: [124, 92, 255] as [number, number, number],
  blue: [78, 168, 255] as [number, number, number],
  tealBright: [34, 225, 195] as [number, number, number],
  /** Light text on the dark band. */
  headText: [245, 246, 255] as [number, number, number],
  headMuted: [180, 183, 217] as [number, number, number],
  kicker: [124, 128, 168] as [number, number, number]
} as const;

/** Which header treatment `createBrandedPdf` draws. */
export type BrandHeader = 'aurora' | 'light';

export type BrandedPdfOptions = {
  reportTitle: string;
  metaLines?: string[];
  landscape?: boolean;
  /**
   * Header style. `'aurora'` (default) draws the dark aurora band with a
   * gradient rule and light logo/text. `'light'` draws a white header + hairline
   * rule + dark logo/text so black-and-white printouts never lose branding.
   */
  brandHeader?: BrandHeader;
};

const HEADER_H = 24;

/** Logo assets: variant-B aurora (light strokes) for the dark band; navy for light. */
const LOGO_AURORA = 'assets/logo-aurora-b.svg';
const LOGO_NAVY = 'assets/logo-ledger-shield-navy.svg';

/** Rasterized-logo cache, keyed by asset path (aurora vs. navy variant). */
const logoCache = new Map<string, string | null>();

async function fetchLogoPngDataUrl(assetPath: string): Promise<string | null> {
  if (logoCache.has(assetPath)) return logoCache.get(assetPath) ?? null;
  try {
    const url = `${import.meta.env.BASE_URL}${assetPath}`;
    const res = await fetch(url);
    if (!res.ok) {
      logoCache.set(assetPath, null);
      return null;
    }
    const svgText = await res.text();
    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const objectUrl = URL.createObjectURL(blob);
    const dataUrl = await new Promise<string | null>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0, 128, 128);
        URL.revokeObjectURL(objectUrl);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(null);
      };
      img.src = objectUrl;
    });
    logoCache.set(assetPath, dataUrl);
    return dataUrl;
  } catch {
    logoCache.set(assetPath, null);
    return null;
  }
}

/** Draw the dark Aurora header band + gradient rule + light logo/branding. */
async function drawAuroraHeader(doc: jsPDF, pageW: number, reportTitle: string) {
  // Two-stop vertical gradient hint: #12132A over #0A0B1A.
  const split = HEADER_H * 0.55;
  doc.setFillColor(...AURORA.bandTop);
  doc.rect(0, 0, pageW, split, 'F');
  doc.setFillColor(...AURORA.bandBottom);
  doc.rect(0, split, pageW, HEADER_H - split, 'F');

  // Aurora gradient rule (violet → blue → teal) along the band's bottom edge.
  const ruleH = 1.1;
  const ruleY = HEADER_H - ruleH;
  const seg = pageW / 3;
  doc.setFillColor(...AURORA.violet);
  doc.rect(0, ruleY, seg, ruleH, 'F');
  doc.setFillColor(...AURORA.blue);
  doc.rect(seg, ruleY, seg, ruleH, 'F');
  doc.setFillColor(...AURORA.tealBright);
  doc.rect(seg * 2, ruleY, pageW - seg * 2, ruleH, 'F');

  const logo = await fetchLogoPngDataUrl(LOGO_AURORA);
  if (logo) doc.addImage(logo, 'PNG', 12, 4.5, 15, 15);

  const textX = logo ? 30 : 14;
  doc.setTextColor(...AURORA.headText);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('SoloLedger', textX, 10);

  doc.setFontSize(6);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...AURORA.headMuted);
  doc.text('PRIVATE · PRECISE · YOURS', textX, 14.5, { charSpace: 0.4 });

  // Right-aligned report title.
  doc.setFontSize(10.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...AURORA.headText);
  doc.text(reportTitle, pageW - 14, 13, { align: 'right', maxWidth: pageW - textX - 18 });
}

/** Draw the light/print-safe header: white band + hairline rule + dark logo/text. */
async function drawLightHeader(doc: jsPDF, pageW: number, reportTitle: string) {
  doc.setFillColor(...PDF.white);
  doc.rect(0, 0, pageW, HEADER_H, 'F');

  // Hairline rule along the bottom edge.
  doc.setDrawColor(...PDF.slateBorder);
  doc.setLineWidth(0.4);
  doc.line(14, HEADER_H, pageW - 14, HEADER_H);

  const logo = await fetchLogoPngDataUrl(LOGO_NAVY);
  if (logo) doc.addImage(logo, 'PNG', 12, 4.5, 15, 15);

  const textX = logo ? 30 : 14;
  doc.setTextColor(...PDF.navy);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('SoloLedger', textX, 10);

  doc.setFontSize(6);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...PDF.slate);
  doc.text('PRIVATE · PRECISE · YOURS', textX, 14.5, { charSpace: 0.4 });

  doc.setFontSize(10.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...PDF.navy);
  doc.text(reportTitle, pageW - 14, 13, { align: 'right', maxWidth: pageW - textX - 18 });
}

/**
 * Create a jsPDF with the SoloLedger branded header and light/print-safe body.
 *
 * The header defaults to the dark Aurora band (`brandHeader: 'aurora'`); pass
 * `brandHeader: 'light'` for a white header that survives black-and-white
 * printing. The body (tables, meta, disclaimer) stays light either way.
 */
export async function createBrandedPdf({
  reportTitle,
  metaLines = [],
  landscape,
  brandHeader = 'aurora'
}: BrandedPdfOptions): Promise<{
  doc: jsPDF;
  startY: number;
}> {
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  const pageW = landscape ? 297 : 210;

  if (brandHeader === 'light') {
    await drawLightHeader(doc, pageW, reportTitle);
  } else {
    await drawAuroraHeader(doc, pageW, reportTitle);
  }

  let y = HEADER_H + 6;
  doc.setTextColor(...PDF.navy);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);

  for (const line of metaLines) {
    doc.text(line, 14, y);
    y += 4.5;
  }

  return { doc, startY: y + 2 };
}

/** Shared jspdf-autotable styles matching the app design system. */
export function pdfTableStyles(fontSize = 8) {
  return {
    theme: 'grid' as const,
    headStyles: {
      fillColor: PDF.navy,
      textColor: PDF.white,
      fontStyle: 'bold' as const,
      fontSize: fontSize - 0.5,
      cellPadding: 2.5
    },
    bodyStyles: {
      fontSize,
      textColor: PDF.navy,
      cellPadding: 2.5
    },
    alternateRowStyles: {
      fillColor: PDF.slateLight
    },
    styles: {
      lineColor: PDF.slateBorder,
      lineWidth: 0.1,
      font: 'helvetica'
    },
    margin: { left: 14, right: 14 }
  };
}

/** Shorten long on-chain refs so PDF tables don't blow out column widths. */
export function truncatePdfRef(ref?: string | null, start = 10, end = 6): string {
  if (!ref) return '—';
  if (ref.length <= start + end + 1) return ref;
  return `${ref.slice(0, start)}…${ref.slice(-end)}`;
}

/** Footer disclaimer on the last page. */
export function addPdfDisclaimer(doc: jsPDF, text: string) {
  const y = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 40;
  doc.setFontSize(7);
  doc.setTextColor(...PDF.slate);
  doc.setFont('helvetica', 'italic');
  const lines = doc.splitTextToSize(text, 180);
  doc.text(lines, 14, y + 8);
}
