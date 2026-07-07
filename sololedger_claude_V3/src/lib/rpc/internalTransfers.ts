import { db, getLookupAddresses } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';

const AMOUNT_EPS = 1e-6;

function amountsMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= AMOUNT_EPS;
}

function isOwnedTransferCandidate(t: Transaction, owned: Set<string>): boolean {
  if (t.isInternalTransfer || t.isSpam) return false;
  if (t.type !== 'transfer_in' && t.type !== 'transfer_out') return false;
  const wallet = t.walletAddress?.toLowerCase();
  const counterparty = t.counterpartyAddress?.toLowerCase();
  if (!wallet || !counterparty) return false;
  return owned.has(wallet) && owned.has(counterparty);
}

function isMatchingPair(out: Transaction, inn: Transaction): boolean {
  return (
    out.type === 'transfer_out' &&
    inn.type === 'transfer_in' &&
    out.walletAddress?.toLowerCase() === inn.counterpartyAddress?.toLowerCase() &&
    inn.walletAddress?.toLowerCase() === out.counterpartyAddress?.toLowerCase() &&
    out.asset.toUpperCase() === inn.asset.toUpperCase() &&
    amountsMatch(out.amount, inn.amount)
  );
}

/**
 * When both sides of a wallet-to-wallet move are imported, mark them internal
 * so Portfolio/Capital Gains exclude the outgoing leg automatically.
 *
 * Matching rules (in order):
 * 1. Same on-chain ref (sourceRef) + opposite direction + owned wallet pair
 * 2. Same asset/amount within 2 minutes + owned wallet pair (fallback)
 */
export async function autoMarkInternalTransfers(): Promise<number> {
  const owned = new Set(
    (await getLookupAddresses()).map((r) => r.address.toLowerCase())
  );
  if (owned.size < 2) return 0;

  const all = await db.transactions.toArray();
  const candidates = all.filter((t) => isOwnedTransferCandidate(t, owned));
  if (candidates.length === 0) return 0;

  const toMark = new Set<string>();

  // Pass 1: same sourceRef (strongest — same on-chain transaction)
  const byRef = new Map<string, Transaction[]>();
  for (const t of candidates) {
    if (!t.sourceRef) continue;
    const key = `${t.chain ?? ''}:${t.sourceRef}`;
    const group = byRef.get(key) ?? [];
    group.push(t);
    byRef.set(key, group);
  }

  for (const group of byRef.values()) {
    const outs = group.filter((t) => t.type === 'transfer_out');
    const ins = group.filter((t) => t.type === 'transfer_in');
    for (const out of outs) {
      for (const inn of ins) {
        if (isMatchingPair(out, inn)) {
          toMark.add(out.id);
          toMark.add(inn.id);
        }
      }
    }
  }

  // Pass 2: timestamp + asset + amount fallback (no shared sourceRef)
  const unmatched = candidates.filter((t) => !toMark.has(t.id));
  const outs = unmatched.filter((t) => t.type === 'transfer_out');
  const ins = unmatched.filter((t) => t.type === 'transfer_in');

  for (const out of outs) {
    for (const inn of ins) {
      if (!isMatchingPair(out, inn)) continue;
      if (Math.abs(out.timestamp - inn.timestamp) > 2 * 60 * 1000) continue;
      toMark.add(out.id);
      toMark.add(inn.id);
    }
  }

  if (toMark.size === 0) return 0;

  let updated = 0;
  await db.transaction('rw', db.transactions, async () => {
    for (const id of toMark) {
      const t = all.find((x) => x.id === id);
      if (!t || t.isInternalTransfer) continue;
      await db.transactions.update(id, {
        isInternalTransfer: true,
        flags: (t.flags ?? []).filter((f) => f !== 'possible_internal_transfer')
      });
      updated++;
    }
  });

  return updated;
}
