import type { Transaction } from '@/types/transaction';

/** Ignore tiny SOL movements that are usually network fees inside a swap tx. */
function isLikelySolFee(tx: Transaction): boolean {
  return tx.asset === 'SOL' && tx.amount < 0.02;
}

/**
 * When a single on-chain transaction moves one asset out and another in (typical DEX
 * swap on Solana/EVM), merge the balance-delta rows into one `trade` row so cost
 * basis and price lookup treat it as a taxable swap rather than non-taxable transfers.
 */
export function detectDexSwaps(transactions: Transaction[]): Transaction[] {
  const standalone: Transaction[] = [];
  const byRef = new Map<string, Transaction[]>();

  for (const tx of transactions) {
    if (!tx.sourceRef || !tx.source.startsWith('rpc:')) {
      standalone.push(tx);
      continue;
    }
    const group = byRef.get(tx.sourceRef) ?? [];
    group.push(tx);
    byRef.set(tx.sourceRef, group);
  }

  for (const group of byRef.values()) {
    if (group.length < 2) {
      standalone.push(...group);
      continue;
    }

    const outs = group.filter((t) => t.type === 'transfer_out' && !isLikelySolFee(t));
    const ins = group.filter((t) => t.type === 'transfer_in' && !isLikelySolFee(t));

    if (outs.length === 1 && ins.length === 1) {
      const out = outs[0];
      const inn = ins[0];
      standalone.push({
        ...out,
        type: 'trade',
        counterAsset: inn.asset,
        counterAmount: inn.amount,
        flags: out.flags.filter((f) => f !== 'possible_internal_transfer'),
        notes: out.notes ?? 'Auto-detected swap from on-chain balance changes.'
      });
      continue;
    }

    standalone.push(...group);
  }

  return standalone;
}
