import jsPDF from 'jspdf';

type Rgb = [number, number, number];

/**
 * Ember & Slate print palette for PDF exports (RGB).
 *
 * PDFs are always LIGHT and ink-friendly (the locked print contract from the
 * redesign): a warm paper-white body, warm charcoal ink, and hairline rules —
 * with the brand confined to ONE solid deep-ember header band (no gradients,
 * so it prints perfectly on any engine). Finance accents mirror the screen
 * theme's light-mode tokens: moss gains, crimson losses, amber accents.
 */
const INK: Rgb = [34, 26, 20]; // #221A14 — warm charcoal (light text-hi)
const INK_SOFT: Rgb = [92, 82, 72]; // #5C5248 — table-head labels (light text-mid)
const MUTED: Rgb = [111, 100, 85]; // #6F6455 — captions / disclaimers (light text-low)
const PAPER: Rgb = [251, 247, 241]; // #FBF7F1 — warm paper canvas (alt rows, tonal fills)
const PAPER_DEEP: Rgb = [244, 237, 227]; // #F4EDE3 — inset well (table head fill)
const HAIRLINE: Rgb = [231, 220, 202]; // #E7DCCA — warm hairline rules
const GAIN: Rgb = [79, 118, 19]; // #4F7613 — moss
const LOSS: Rgb = [190, 18, 60]; // #BE123C — crimson
const AMBER: Rgb = [180, 83, 9]; // #B45309 — amber accent
const WHITE: Rgb = [255, 255, 255];

export const PDF = {
  ink: INK,
  inkSoft: INK_SOFT,
  muted: MUTED,
  paper: PAPER,
  paperDeep: PAPER_DEEP,
  hairline: HAIRLINE,
  gain: GAIN,
  loss: LOSS,
  amber: AMBER,
  white: WHITE,
  /** @deprecated Ember & Slate rename — use {@link PDF.ink}. */
  navy: INK,
  /** @deprecated Ember & Slate rename — use {@link PDF.muted}. */
  slate: MUTED,
  /** @deprecated Ember & Slate rename — use {@link PDF.paper}. */
  slateLight: PAPER,
  /** @deprecated Ember & Slate rename — use {@link PDF.hairline}. */
  slateBorder: HAIRLINE,
  /** @deprecated Retired Aurora teal — use {@link PDF.gain} (moss). */
  teal: GAIN
} as const;

/**
 * Ember header palette (RGB) — the branded band drawn by `createBrandedPdf`.
 * Replaces the retired Aurora navy band (two-stop navy gradient hint with a
 * violet→blue→teal rule): the band is now one SOLID deep-ember fill with a
 * single solid amber rule — print-safe, no gradients anywhere.
 *
 * The report BODY stays light/print-safe (see {@link pdfTableStyles}); only
 * the branded header band uses these tokens.
 */
export const EMBER = {
  /** Solid header band — deep ember #9A3412 (light-theme primary-deep). */
  band: [154, 52, 18] as Rgb,
  /** Solid amber rule along the band's bottom edge — #D97706. */
  rule: [217, 119, 6] as Rgb,
  /** Warm-white text on the ember band. */
  headText: [255, 253, 251] as Rgb,
  /** Soft peach secondary text on the ember band — #F5B77F. */
  headMuted: [245, 183, 127] as Rgb
} as const;

/**
 * Which header treatment `createBrandedPdf` draws. `'aurora'` is kept as a
 * deprecated alias of `'ember'` so existing callers keep working — both draw
 * the solid ember band.
 */
export type BrandHeader = 'ember' | 'aurora' | 'light';

export type BrandedPdfOptions = {
  reportTitle: string;
  metaLines?: string[];
  landscape?: boolean;
  /**
   * Header style. `'ember'` (default; `'aurora'` is a deprecated alias) draws
   * the solid deep-ember band with a solid amber rule and warm-white
   * logo/text. `'light'` draws a white header + hairline rule + dark
   * logo/text so black-and-white printouts never lose branding.
   */
  brandHeader?: BrandHeader;
};

const HEADER_H = 24;

/** Logo assets: white-stroked shield for the ember band; charcoal for light. */
const LOGO_ON_EMBER = 'assets/logo-ledger-shield-ember.svg';
const LOGO_PRINT = 'assets/logo-ledger-shield-navy.svg';

/** Rasterized-logo cache, keyed by asset path (ember vs. print variant). */
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

/** Draw the solid ember header band + amber rule + white logo/branding. */
async function drawEmberHeader(doc: jsPDF, pageW: number, reportTitle: string) {
  // One SOLID deep-ember band — no gradient, so every print engine renders it.
  doc.setFillColor(...EMBER.band);
  doc.rect(0, 0, pageW, HEADER_H, 'F');

  // Solid amber rule along the band's bottom edge (brand echo, not a gradient).
  const ruleH = 1.1;
  doc.setFillColor(...EMBER.rule);
  doc.rect(0, HEADER_H - ruleH, pageW, ruleH, 'F');

  const logo = await fetchLogoPngDataUrl(LOGO_ON_EMBER);
  if (logo) doc.addImage(logo, 'PNG', 12, 4.5, 15, 15);

  const textX = logo ? 30 : 14;
  doc.setTextColor(...EMBER.headText);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('SoloLedger', textX, 10);

  doc.setFontSize(6);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...EMBER.headMuted);
  doc.text('PRIVATE · PRECISE · YOURS', textX, 14.5, { charSpace: 0.4 });

  // Right-aligned report title.
  doc.setFontSize(10.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...EMBER.headText);
  doc.text(reportTitle, pageW - 14, 13, { align: 'right', maxWidth: pageW - textX - 18 });
}

/** Draw the light/print-safe header: white band + hairline rule + dark logo/text. */
async function drawLightHeader(doc: jsPDF, pageW: number, reportTitle: string) {
  doc.setFillColor(...PDF.white);
  doc.rect(0, 0, pageW, HEADER_H, 'F');

  // Hairline rule along the bottom edge.
  doc.setDrawColor(...PDF.hairline);
  doc.setLineWidth(0.4);
  doc.line(14, HEADER_H, pageW - 14, HEADER_H);

  const logo = await fetchLogoPngDataUrl(LOGO_PRINT);
  if (logo) doc.addImage(logo, 'PNG', 12, 4.5, 15, 15);

  const textX = logo ? 30 : 14;
  doc.setTextColor(...PDF.ink);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('SoloLedger', textX, 10);

  doc.setFontSize(6);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...PDF.muted);
  doc.text('PRIVATE · PRECISE · YOURS', textX, 14.5, { charSpace: 0.4 });

  doc.setFontSize(10.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...PDF.ink);
  doc.text(reportTitle, pageW - 14, 13, { align: 'right', maxWidth: pageW - textX - 18 });
}

/**
 * Create a jsPDF with the SoloLedger branded header and light/print-safe body.
 *
 * The header defaults to the solid ember band (`brandHeader: 'ember'`;
 * `'aurora'` is accepted as a deprecated alias); pass `brandHeader: 'light'`
 * for a white header that survives black-and-white printing. The body
 * (tables, meta, disclaimer) stays light either way.
 */
export async function createBrandedPdf({
  reportTitle,
  metaLines = [],
  landscape,
  brandHeader = 'ember'
}: BrandedPdfOptions): Promise<{
  doc: jsPDF;
  startY: number;
}> {
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  const pageW = landscape ? 297 : 210;

  if (brandHeader === 'light') {
    await drawLightHeader(doc, pageW, reportTitle);
  } else {
    await drawEmberHeader(doc, pageW, reportTitle);
  }

  let y = HEADER_H + 6;
  doc.setTextColor(...PDF.ink);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);

  for (const line of metaLines) {
    doc.text(line, 14, y);
    y += 4.5;
  }

  return { doc, startY: y + 2 };
}

/**
 * Shared jspdf-autotable styles matching the Ember & Slate print system:
 * warm-paper alternating rows, a soft inset-well table head, warm hairline
 * rules and warm charcoal ink — light and ink-friendly throughout.
 */
export function pdfTableStyles(fontSize = 8) {
  return {
    theme: 'grid' as const,
    headStyles: {
      fillColor: PDF.paperDeep,
      textColor: PDF.inkSoft,
      fontStyle: 'bold' as const,
      fontSize: fontSize - 0.5,
      cellPadding: 2.5
    },
    bodyStyles: {
      fontSize,
      textColor: PDF.ink,
      cellPadding: 2.5
    },
    alternateRowStyles: {
      fillColor: PDF.paper
    },
    styles: {
      lineColor: PDF.hairline,
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
  doc.setTextColor(...PDF.muted);
  doc.setFont('helvetica', 'italic');
  const lines = doc.splitTextToSize(text, 180);
  doc.text(lines, 14, y + 8);
}
