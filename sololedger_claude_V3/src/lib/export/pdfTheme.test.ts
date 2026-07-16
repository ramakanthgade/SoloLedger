import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Branded-PDF header tests (Task T5).
 *
 * jsPDF assigns its drawing methods per-instance (via its plugin API), so we
 * mock the `jspdf` module with a lightweight recording fake that captures every
 * fill/text/rect/line/image call `createBrandedPdf` issues. We also stub the
 * logo rasterization pipeline (fetch → Image → canvas) so the logo path runs
 * deterministically under jsdom instead of falling back to null.
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
const { createBrandedPdf, AURORA, PDF } = await import('./pdfTheme');

const AURORA_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"></svg>';

/** Stub the SVG→PNG rasterization so the logo path resolves to a data URL. */
function stubLogoPipeline() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, text: async () => AURORA_SVG }) as unknown as Response)
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

describe('createBrandedPdf — Aurora header (default)', () => {
  beforeEach(() => stubLogoPipeline());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('draws the dark aurora band, gradient rule, logo, tagline and right-aligned title', async () => {
    const { doc, startY } = await createBrandedPdf({
      reportTitle: 'Schedule VDA — FY 2024–25',
      metaLines: ['Jurisdiction: India']
    });
    const d = doc as unknown as FakeDoc;

    expect(startY).toBeGreaterThan(24);

    // Dark aurora band: both gradient-hint fills are used.
    expect(hasColor(d.fillCalls, AURORA.bandTop)).toBe(true);
    expect(hasColor(d.fillCalls, AURORA.bandBottom)).toBe(true);

    // Aurora gradient rule stops (violet → blue → teal).
    expect(hasColor(d.fillCalls, AURORA.violet)).toBe(true);
    expect(hasColor(d.fillCalls, AURORA.blue)).toBe(true);
    expect(hasColor(d.fillCalls, AURORA.tealBright)).toBe(true);

    // Logo rasterized and placed.
    expect(d.imageCalls.length).toBe(1);
    expect(d.imageCalls[0][1]).toBe('PNG');

    // Wordmark, tagline and report title all rendered.
    const texts = textStrings(d.textCalls);
    expect(texts).toContain('SoloLedger');
    expect(texts).toContain('PRIVATE · PRECISE · YOURS');
    expect(texts).toContain('Schedule VDA — FY 2024–25');

    // Header text uses the light aurora ink, not dark navy.
    expect(hasColor(d.textColorCalls, AURORA.headText)).toBe(true);

    // Title is right-aligned.
    const titleCall = d.textCalls.find((c) => c[0] === 'Schedule VDA — FY 2024–25');
    expect(titleCall?.[3]).toMatchObject({ align: 'right' });
  });

  it('uses the aurora variant when brandHeader is omitted', async () => {
    const { doc } = await createBrandedPdf({ reportTitle: 'Capital Gains Report' });
    const d = doc as unknown as FakeDoc;
    expect(hasColor(d.fillCalls, AURORA.bandTop)).toBe(true);
    expect(hasColor(d.textColorCalls, AURORA.headText)).toBe(true);
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
    // No dark aurora band in the light variant.
    expect(hasColor(d.fillCalls, AURORA.bandTop)).toBe(false);
    expect(hasColor(d.fillCalls, AURORA.bandBottom)).toBe(false);

    // Hairline rule drawn (light variant uses line()).
    expect(d.lineCalls.length).toBeGreaterThan(0);

    // Dark logo + dark navy text for B/W legibility.
    expect(d.imageCalls.length).toBe(1);
    expect(hasColor(d.textColorCalls, PDF.navy)).toBe(true);
    // Light header must NOT use the light aurora ink (would vanish on white).
    expect(hasColor(d.textColorCalls, AURORA.headText)).toBe(false);

    const texts = textStrings(d.textCalls);
    expect(texts).toContain('SoloLedger');
    expect(texts).toContain('PRIVATE · PRECISE · YOURS');
    expect(texts).toContain('Schedule VDA — FY 2024–25');
  });
});
