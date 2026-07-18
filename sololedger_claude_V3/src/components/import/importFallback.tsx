/**
 * Graduated fallback messaging for imports the deterministic parsers can't read.
 *
 * When the generic parser (and all registry parsers) fail to produce
 * transactions, `FileParseOutcome.missingFields` tells us WHICH required field
 * was absent. These helpers turn that into actionable "fix-the-file" guidance
 * plus the last-resort AI-mapping note, shared by ImportTab and ConnectionWizard.
 */
import { AlertTriangle } from 'lucide-react';
import type { MissingField } from '@/lib/parsers/types';

/** Data-sharing disclosure shown next to any AI-mapping affordance. */
export const AI_MAPPING_DISCLOSURE =
  'AI mapping sends only your column names and a small sample (up to 8 rows) to identify columns — not your full file or saved transactions.';

const FIELD_GUIDANCE: Record<MissingField, string> = {
  type: "Add a 'Type' column with values like deposit/withdrawal/buy/sell, then re-upload.",
  timestamp: "Add a date/time column (e.g. 'Time' or 'Date').",
  asset: "Add a coin/asset column (e.g. 'Coin' or 'Asset').",
  amount: 'Add an amount/quantity column.',
  preamble:
    'Delete the summary rows at the top of the sheet so the column headers are the first row.'
};

/** Actionable fix-the-file lines derived from which required fields were missing. */
export function fixTheFileGuidance(missingFields: MissingField[] | undefined): string[] {
  if (!missingFields || missingFields.length === 0) return [];
  // Preserve a sensible order and de-dupe.
  const order: MissingField[] = ['preamble', 'timestamp', 'asset', 'amount', 'type'];
  const seen = new Set(missingFields);
  return order.filter((f) => seen.has(f)).map((f) => FIELD_GUIDANCE[f]);
}

/**
 * Last-resort note explaining AI column-mapping.
 * @param aiAvailable whether `hasAiAdvisor(effectiveSettings)` is true.
 */
export function aiLastResortNote(aiAvailable: boolean): string {
  if (aiAvailable) {
    return 'Still stuck? Try AI column-mapping — it can identify the columns for you.';
  }
  return (
    'Still stuck? AI column-mapping can identify the columns for you. To enable it: ' +
    '(a) add your own AI API key in Settings, or (b) switch to Hosted: Managed mode, ' +
    'where the app supplies the AI key automatically. You can also map the columns yourself ' +
    'on the Import tab.'
  );
}

/**
 * Full fallback message block for a failed parse: fix-the-file guidance lines,
 * then the AI last-resort note. Returned as an ordered list of strings.
 */
export function buildFallbackMessages(
  missingFields: MissingField[] | undefined,
  aiAvailable: boolean
): string[] {
  const lines = fixTheFileGuidance(missingFields);
  if (lines.length === 0) {
    lines.push(
      'We could not read transactions from this file. Check you exported the right report (a transaction/trade history), or map the columns manually on the Import tab.'
    );
  }
  lines.push(aiLastResortNote(aiAvailable));
  return lines;
}

/**
 * Shared presentational panel that renders the graduated "fix-the-file"
 * guidance list followed by the AI data-sharing disclosure. Used by both
 * ImportTab and ConnectionWizard so the copy stays byte-identical.
 */
export function FixTheFileGuidance({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <div className="space-y-2 rounded-lg border border-warn/25 bg-warn/[0.06] px-3 py-3">
      <p className="text-xs font-bold text-hi">Here's how to fix this file</p>
      <ul className="space-y-1.5">
        {messages.map((m, i) => (
          <li key={i} className="flex items-start gap-2 text-xs text-mid">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
            <span>{m}</span>
          </li>
        ))}
      </ul>
      <p className="pl-5 text-[11px] text-low">{AI_MAPPING_DISCLOSURE}</p>
    </div>
  );
}
