/**
 * Best-effort address-orientation confirmation for ambiguous single-"Address"
 * imports (Issue 4, Task 4).
 *
 * When the generic parser resolves addresses from a single "Address" column it
 * assumes the address is the "To" side (baseline). That baseline is right for a
 * deposit (funds arriving at your wallet) but wrong for many withdrawals, where
 * the exchange's "Address" is the DESTINATION counterparty, not you. In a
 * non-local mode we can confirm the guess by looking up one or two rows'
 * on-chain from/to via Blockscout and, if the sample shows the sheet address is
 * actually the FROM side, flip orientation consistently for the whole batch.
 *
 * Strictly best-effort and non-fatal: local mode never runs it (stays offline),
 * any network/lookup failure returns the input unchanged, and only the
 * ambiguous batch's rows are ever touched.
 */
import type { Transaction } from '@/types/transaction';
import { getMode } from '@/lib/saas/mode';
import { getEffectiveSettings, hasWalletLookupKeys } from '@/lib/saas/effectiveSettings';
import { fetchBlockscoutTxParties } from '@/lib/rpc/providers';

/** The address the assume-To baseline placed on a tx (only one side is set). */
function sheetAddressOf(t: Transaction): string | undefined {
  if (t.type === 'transfer_in') return t.walletAddress;
  if (t.type === 'transfer_out') return t.counterpartyAddress;
  return undefined;
}

/** Swap walletAddress ↔ counterpartyAddress (the orientation flip). */
function flip(t: Transaction): Transaction {
  return { ...t, walletAddress: t.counterpartyAddress, counterpartyAddress: t.walletAddress };
}

/**
 * Confirm/repair address orientation for a batch of ambiguously-oriented txs.
 * Returns the (possibly flipped) list; never throws.
 */
export async function confirmAddressOrientation(txs: Transaction[]): Promise<Transaction[]> {
  try {
    const mode = getMode();
    if (mode === 'local') return txs;
    const settings = await getEffectiveSettings();
    const allowed = mode === 'hosted' || (mode === 'byok' && hasWalletLookupKeys(settings));
    if (!allowed) return txs;

    // Candidate samples: EVM (0x) tx hash + a sheet address we can compare.
    const samples = txs.filter((t) => {
      const hash = t.txHash;
      const addr = sheetAddressOf(t);
      return Boolean(hash && /^0x[0-9a-fA-F]{6,}$/.test(hash) && addr && /^0x/i.test(addr));
    });
    if (samples.length === 0) return txs;

    let shouldFlip: boolean | null = null;
    for (const sample of samples.slice(0, 2)) {
      const parties = await fetchBlockscoutTxParties(sample.txHash!);
      if (!parties) continue;
      const addr = sheetAddressOf(sample)!.toLowerCase();
      if (parties.to && addr === parties.to) {
        // Assume-To baseline was correct.
        shouldFlip = false;
        break;
      }
      if (parties.from && addr === parties.from) {
        // Sheet address is actually the FROM side → flip the batch.
        shouldFlip = true;
        break;
      }
    }

    if (shouldFlip !== true) return txs;
    return txs.map((t) => (t.type === 'transfer_in' || t.type === 'transfer_out' ? flip(t) : t));
  } catch {
    return txs;
  }
}

/** A parsed sheet as far as orientation cares: its rows + whether they were ambiguous. */
interface OrientableSheet {
  skipped: boolean;
  detectedParser: string | null;
  transactions: Transaction[];
  addressColumnAmbiguous?: boolean;
}

/**
 * Re-orient a multi-sheet parse result's transactions: run
 * `confirmAddressOrientation` over ONLY the ambiguous sheets' rows and rebuild
 * the merged transaction list, leaving clearly-named / non-generic sheets
 * untouched. When no sheet is ambiguous, returns `fallback` unchanged (avoiding
 * the rebuild). Shared by the auto-detected import paths in ImportTab and
 * ConnectionWizard.
 */
export async function confirmSheetOrientations(
  sheets: OrientableSheet[],
  fallback: Transaction[]
): Promise<Transaction[]> {
  if (!sheets.some((s) => s.addressColumnAmbiguous)) return fallback;
  const rebuilt: Transaction[] = [];
  for (const s of sheets) {
    if (s.skipped || !s.detectedParser || s.transactions.length === 0) continue;
    rebuilt.push(
      ...(s.addressColumnAmbiguous ? await confirmAddressOrientation(s.transactions) : s.transactions)
    );
  }
  return rebuilt;
}
