import { describe, it, expect } from 'vitest';
import {
  fixTheFileGuidance,
  aiLastResortNote,
  buildFallbackMessages,
  AI_MAPPING_DISCLOSURE
} from './importFallback';
import { detectMissingFields } from '@/lib/parsers/genericHistory';

describe('fixTheFileGuidance — actionable copy per missing field', () => {
  it('maps each missing field to a specific instruction', () => {
    expect(fixTheFileGuidance(['type'])[0]).toMatch(/Type.*column/i);
    expect(fixTheFileGuidance(['timestamp'])[0]).toMatch(/date\/time column/i);
    expect(fixTheFileGuidance(['asset'])[0]).toMatch(/coin\/asset column/i);
    expect(fixTheFileGuidance(['amount'])[0]).toMatch(/amount\/quantity column/i);
    expect(fixTheFileGuidance(['preamble'])[0]).toMatch(/summary rows at the top/i);
  });

  it('orders and de-dupes multiple missing fields deterministically', () => {
    const lines = fixTheFileGuidance(['type', 'timestamp', 'preamble', 'type']);
    // preamble → timestamp → type order, no dupes
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/summary rows/i);
    expect(lines[1]).toMatch(/date\/time/i);
    expect(lines[2]).toMatch(/Type.*column/i);
  });

  it('returns [] when nothing is missing', () => {
    expect(fixTheFileGuidance(undefined)).toEqual([]);
    expect(fixTheFileGuidance([])).toEqual([]);
  });
});

describe('aiLastResortNote — explains both enablement paths when unavailable', () => {
  it('short note when AI is available', () => {
    const note = aiLastResortNote(true);
    expect(note).toMatch(/AI column-mapping/i);
    expect(note).not.toMatch(/Hosted/i);
  });

  it('explains own-key AND Hosted:Managed when AI is unavailable', () => {
    const note = aiLastResortNote(false);
    expect(note).toMatch(/add your own AI API key/i);
    expect(note).toMatch(/Hosted: Managed/i);
    expect(note).toMatch(/Import tab/i);
  });
});

describe('buildFallbackMessages', () => {
  it('includes fix-the-file lines then the AI note', () => {
    const msgs = buildFallbackMessages(['type'], false);
    expect(msgs[0]).toMatch(/Type.*column/i);
    expect(msgs[msgs.length - 1]).toMatch(/Hosted: Managed/i);
  });

  it('falls back to a generic-but-helpful line when nothing specific is missing', () => {
    const msgs = buildFallbackMessages(undefined, true);
    expect(msgs[0]).toMatch(/could not read transactions/i);
    expect(msgs[msgs.length - 1]).toMatch(/AI column-mapping/i);
  });

  it('exposes a data-sharing disclosure constant', () => {
    expect(AI_MAPPING_DISCLOSURE).toMatch(/only your column names/i);
    expect(AI_MAPPING_DISCLOSURE).toMatch(/up to 8 rows/i);
    expect(AI_MAPPING_DISCLOSURE).toMatch(/not your full file/i);
  });
});

describe('missingFields derivation drives the guidance end-to-end', () => {
  it('a type-less, title-less deposit sheet yields a type guidance line', () => {
    const missing = detectMissingFields(['Time', 'Coin', 'Amount']);
    expect(missing).toEqual(['type']);
    const msgs = buildFallbackMessages(missing, false);
    expect(msgs.some((m) => /Type.*column/i.test(m))).toBe(true);
  });

  it('a sheet missing amount + asset yields both guidance lines', () => {
    const missing = detectMissingFields(['Time', 'Type']);
    expect(missing.sort()).toEqual(['amount', 'asset']);
    const msgs = buildFallbackMessages(missing, true);
    expect(msgs.some((m) => /coin\/asset column/i.test(m))).toBe(true);
    expect(msgs.some((m) => /amount\/quantity column/i.test(m))).toBe(true);
  });
});
