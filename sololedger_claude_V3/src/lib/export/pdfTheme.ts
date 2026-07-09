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

export type BrandedPdfOptions = {
  reportTitle: string;
  metaLines?: string[];
  landscape?: boolean;
};

const HEADER_H = 24;
let logoCache: string | null | undefined;

async function fetchLogoPngDataUrl(): Promise<string | null> {
  if (logoCache !== undefined) return logoCache;
  try {
    const url = `${import.meta.env.BASE_URL}assets/logo-ledger-shield.svg`;
    const res = await fetch(url);
    if (!res.ok) {
      logoCache = null;
      return null;
    }
    const svgText = await res.text();
    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const objectUrl = URL.createObjectURL(blob);
    logoCache = await new Promise<string | null>((resolve) => {
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
    return logoCache;
  } catch {
    logoCache = null;
    return null;
  }
}

/** Create a jsPDF with SoloLedger navy header bar, logo, and branding. */
export async function createBrandedPdf({ reportTitle, metaLines = [], landscape }: BrandedPdfOptions): Promise<{
  doc: jsPDF;
  startY: number;
}> {
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  const pageW = landscape ? 297 : 210;

  doc.setFillColor(...PDF.navy);
  doc.rect(0, 0, pageW, HEADER_H, 'F');

  const logo = await fetchLogoPngDataUrl();
  if (logo) {
    doc.addImage(logo, 'PNG', 12, 4.5, 15, 15);
  }

  const textX = logo ? 30 : 14;
  doc.setTextColor(...PDF.white);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('SoloLedger', textX, 9);

  doc.setFontSize(6.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(203, 213, 225);
  doc.text('Private. Precise. Yours.', textX, 13.5);

  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...PDF.white);
  doc.text(reportTitle, textX, 19.5);

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

/** Footer disclaimer on the last page. */
export function addPdfDisclaimer(doc: jsPDF, text: string) {
  const y = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 40;
  doc.setFontSize(7);
  doc.setTextColor(...PDF.slate);
  doc.setFont('helvetica', 'italic');
  const lines = doc.splitTextToSize(text, 180);
  doc.text(lines, 14, y + 8);
}
