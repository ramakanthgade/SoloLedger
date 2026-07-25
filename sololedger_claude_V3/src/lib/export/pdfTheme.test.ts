import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Branded-PDF header tests (Task T5, restyled Ember & Slate 25 Jul 2026).
 *
 * jsPDF assigns its drawing methods per-instance (via its plugin API), so we
 * mock the `jspdf` module with a lightweight recording fake that captures every
 * fill/text/rect/line/image call `createBrandedPdf` issues. We also stub the
 * logo rasterization pipeline (fetch → Image → canvas) so the logo path runs
 * deterministically under jsdom instead of falling back to null.
 *
 * The print contract under test: the branded header is ONE SOLID deep-ember
 * band with a single solid amber rule (no gradients — print-safe), and the
 * light fallback is a white band with a hairline rule and dark ink text.
 */

type Call = unknown[];

class FakeDoc {
  // Recording arrays are prefixed so they never shadow the method names below.
  fillCalls: Call[] = [];
  drawCalls: Call[] = [];
  textColorCalls: Call[] = [];
  rectCalls: Call[] = [];
  lineCalls: Call[] = [];
  textCalls: Call[] = [];
  imageCalls: Call[] = [];

  constructor(public opts: unknown) {}

  setFillColor(...a: Call) {
    this.fillCalls.push(a);
    return this;
  }
  setDrawColor(...a: Call) {
    this.drawCalls.push(a);
    return this;
  }
  setTextColor(...a: Call) {
    this.textColorCalls.push(a);
    return this;
  }
  setLineWidth() {
    return this;
  }
  setFontSize() {
    return this;
  }
  setFont() {
    return this;
  }
  rect(...a: Call) {
    this.rectCalls.push(a);
    return this;
  }
  line(...a: Call) {
    this.lineCalls.push(a);
    return this;
  }
  text(...a: Call) {
    this.textCalls.push(a);
    return this;
  }
  addImage(...a: Call) {
    this.imageCalls.push(a);
    return this;
  }
  splitTextToSize(t: string) {
    return [t];
  }
}

vi.mock('jspdf', () => ({ default: FakeDoc }));

// Imported after the mock is registered.
const { createBrandedPdf, pdfTableStyles, EMBER, PDF } = await import('./pdfTheme');

const SHIELD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"></svg>';

/** Retired Aurora header fills/rules that must never be drawn again. */
const RETIRED_AURORA_RGB: readonly [number, number, number][] = [
  [18, 19, 42], // bandTop #12132A
  [10, 11, 26], // bandBottom #0A0B1A
  [124, 92, 255], // violet rule
  [78, 168, 255], // blue rule
  [34, 225, 195] // teal rule
];

/** Stub the SVG→PNG rasterization so the logo path resolves to a data URL. */
function stubLogoPipeline() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, text: async () => SHIELD_SVG }) as unknown as Response)
  );

  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private _src = '';
    set src(v: string) {
      this._src = v;
      queueMicrotask(() => this.onload?.());
    }
    get src() {
      return this._src;
    }
  }
  vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn()
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
}

function textStrings(calls: Call[]): string[] {
  return calls.map((c) => String(c[0]));
}

/** True if any RGB call matches the given triple. */
function hasColor(calls: Call[], rgb: readonly [number, number, number]): boolean {
  return calls.some((c) => c[0] === rgb[0] && c[1] === rgb[1] && c[2] === rgb[2]);
}

describe('createBrandedPdf — Ember header (default)', () => {
  beforeEach(() => stubLogoPipeline());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('draws the solid ember band, amber rule, logo, tagline and right-aligned title', async () => {
    const { doc, startY } = await createBrandedPdf({
      reportTitle: 'Schedule VDA — FY 2024–25',
      metaLines: ['Jurisdiction: India']
    });
    const d = doc as unknown as FakeDoc;

    expect(startY).toBeGreaterThan(24);

    // Solid deep-ember band + single solid amber rule (no gradient stops).
    expect(hasColor(d.fillCalls, EMBER.band)).toBe(true);
    expect(hasColor(d.fillCalls, EMBER.rule)).toBe(true);

    // The retired Aurora navy band and violet→blue→teal rule are gone.
    for (const rgb of RETIRED_AURORA_RGB) {
      expect(hasColor(d.fillCalls, rgb)).toBe(false);
    }

    // Logo rasterized and placed.
    expect(d.imageCalls.length).toBe(1);
    expect(d.imageCalls[0][1]).toBe('PNG');

    // Wordmark, tagline and report title all rendered.
    const texts = textStrings(d.textCalls);
    expect(texts).toContain('SoloLedger');
    expect(texts).toContain('PRIVATE · PRECISE · YOURS');
    expect(texts).toContain('Schedule VDA — FY 2024–25');

    // Header text uses the warm-white on-ember ink, not the dark body ink.
    expect(hasColor(d.textColorCalls, EMBER.headText)).toBe(true);

    // Title is right-aligned.
    const titleCall = d.textCalls.find((c) => c[0] === 'Schedule VDA — FY 2024–25');
    expect(titleCall?.[3]).toMatchObject({ align: 'right' });
  });

  it('uses the ember band when brandHeader is omitted', async () => {
    const { doc } = await createBrandedPdf({ reportTitle: 'Capital Gains Report' });
    const d = doc as unknown as FakeDoc;
    expect(hasColor(d.fillCalls, EMBER.band)).toBe(true);
    expect(hasColor(d.textColorCalls, EMBER.headText)).toBe(true);
  });

  it("keeps the deprecated 'aurora' option working as an alias of the ember band", async () => {
    const { doc } = await createBrandedPdf({
      reportTitle: 'Capital Gains Report',
      brandHeader: 'aurora'
    });
    const d = doc as unknown as FakeDoc;
    expect(hasColor(d.fillCalls, EMBER.band)).toBe(true);
    for (const rgb of RETIRED_AURORA_RGB) {
      expect(hasColor(d.fillCalls, rgb)).toBe(false);
    }
  });
});

describe('createBrandedPdf — light header fallback', () => {
  beforeEach(() => stubLogoPipeline());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('draws a white band + hairline rule + dark logo/text', async () => {
    const { doc } = await createBrandedPdf({
      reportTitle: 'Schedule VDA — FY 2024–25',
      brandHeader: 'light'
    });
    const d = doc as unknown as FakeDoc;

    // White header band.
    expect(hasColor(d.fillCalls, PDF.white)).toBe(true);
    // No ember band in the light variant.
    expect(hasColor(d.fillCalls, EMBER.band)).toBe(false);
    expect(hasColor(d.fillCalls, EMBER.rule)).toBe(false);

    // Hairline rule drawn (light variant uses line()).
    expect(d.lineCalls.length).toBeGreaterThan(0);
    expect(hasColor(d.drawCalls, PDF.hairline)).toBe(true);

    // Dark logo + dark warm-ink text for B/W legibility.
    expect(d.imageCalls.length).toBe(1);
    expect(hasColor(d.textColorCalls, PDF.ink)).toBe(true);
    // Light header must NOT use the warm-white band ink (would vanish on white).
    expect(hasColor(d.textColorCalls, EMBER.headText)).toBe(false);

    const texts = textStrings(d.textCalls);
    expect(texts).toContain('SoloLedger');
    expect(texts).toContain('PRIVATE · PRECISE · YOURS');
    expect(texts).toContain('Schedule VDA — FY 2024–25');
  });
});

describe('pdfTableStyles — warm, ink-friendly Ember print tables', () => {
  it('uses a warm inset-well head, charcoal body ink, paper alt-rows and warm hairlines', () => {
    const styles = pdfTableStyles(8);

    // Light warm table head (ink-friendly), bold soft-ink labels.
    expect(styles.headStyles.fillColor).toBe(PDF.paperDeep);
    expect(styles.headStyles.textColor).toBe(PDF.inkSoft);

    // Body in warm charcoal on white, alternating warm-paper rows.
    expect(styles.bodyStyles.textColor).toBe(PDF.ink);
    expect(styles.alternateRowStyles.fillColor).toBe(PDF.paper);

    // Warm hairline grid rules.
    expect(styles.styles.lineColor).toBe(PDF.hairline);
  });

  it('keeps the retired Aurora navy head fill out of the table styles', () => {
    const styles = pdfTableStyles(8);
    // Old navy head fill [11, 31, 58] must not come back.
    expect(styles.headStyles.fillColor).not.toEqual([11, 31, 58]);
  });
});

describe('PDF print palette — back-compat aliases stay stable', () => {
  it('maps the old navy/slate names onto the Ember tokens', () => {
    // Consumers written against the old palette keep working; the aliases now
    // resolve to the warm Ember & Slate print tokens.
    expect(PDF.navy).toBe(PDF.ink);
    expect(PDF.slate).toBe(PDF.muted);
    expect(PDF.slateLight).toBe(PDF.paper);
    expect(PDF.slateBorder).toBe(PDF.hairline);
    expect(PDF.teal).toBe(PDF.gain);
  });

  it('exposes the finance accents (moss gains, crimson losses, amber accents)', () => {
    expect(PDF.gain).toEqual([79, 118, 19]); // #4F7613 moss
    expect(PDF.loss).toEqual([190, 18, 60]); // #BE123C crimson
    expect(PDF.amber).toEqual([180, 83, 9]); // #B45309 amber
  });
});
