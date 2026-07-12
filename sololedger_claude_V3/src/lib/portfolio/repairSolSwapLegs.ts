/**
 * Repair incomplete USDC→SOL (etc.) swap trades that never recorded the native SOL leg.
 * Uses public Solana RPC — no API key required.
 */
import { db } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';

const WSOL = 'So11111111111111111111111111111111111111112';
const RPC = 'https://api.mainnet-beta.solana.com';

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    if (!res.ok) return null;
    const json = await res.json();
    return (json?.result as T) ?? null;
  } catch {
    return null;
  }
}

function tradeTouchesSolFully(t: Transaction): boolean {
  if (t.asset === 'SOL' && t.amount > 0) return true;
  return t.counterAsset?.toUpperCase() === 'SOL' && (t.counterAmount ?? 0) > 0;
}

/**
 * For Solana `trade` rows missing a SOL leg, fetch on-chain native SOL delta
 * (excluding fee) and patch counterAsset/counterAmount when the wallet received SOL.
 */
export async function repairMissingSolSwapLegs(): Promise<number> {
  const trades = await db.transactions
    .filter(
      (t) =>
        t.type === 'trade' &&
        t.chain === 'solana' &&
        !!t.sourceRef &&
        !!t.walletAddress &&
        !t.isSpam &&
        !tradeTouchesSolFully(t)
    )
    .toArray();

  // One repair attempt per signature
  const bySig = new Map<string, Transaction>();
  for (const t of trades) {
    const key = `${t.walletAddress!.toLowerCase()}|${t.sourceRef!}`;
    if (!bySig.has(key)) bySig.set(key, t);
  }

  let updated = 0;
  for (const trade of bySig.values()) {
    const sig = trade.sourceRef!;
    const wallet = trade.walletAddress!;
    // eslint-disable-next-line no-await-in-loop
    const tx = await rpc<{
      meta?: {
        fee?: number;
        preBalances?: number[];
        postBalances?: number[];
      };
      transaction?: {
        message?: {
          accountKeys?: Array<string | { pubkey: string }>;
        };
      };
    }>('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);

    if (!tx?.meta?.preBalances || !tx.meta.postBalances) continue;
    const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
      typeof k === 'string' ? k : k.pubkey
    );
    const idx = keys.findIndex((k) => k === wallet);
    if (idx < 0) continue;

    const solDelta = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
    const feeSol = (tx.meta.fee ?? 0) / 1e9;
    // Native delta already includes −fee; add fee back to recover swap-associated SOL.
    const solFromSwap = solDelta + feeSol;

    if (solFromSwap > 0.001 && trade.asset.toUpperCase() !== 'SOL') {
      // eslint-disable-next-line no-await-in-loop
      await db.transactions.update(trade.id, {
        counterAsset: 'SOL',
        counterAmount: solFromSwap,
        notes:
          trade.notes?.includes('SOL leg repaired')
            ? trade.notes
            : `${trade.notes ? `${trade.notes} · ` : ''}SOL leg repaired from on-chain balance`
      });
      updated++;
    } else if (solFromSwap < -0.001 && trade.counterAsset?.toUpperCase() !== 'SOL') {
      // Sold SOL for a token but trade only recorded the token side somehow — rare.
      // Prefer leaving asset as SOL out if currently a non-SOL asset with empty counter.
      if (!trade.counterAsset || (trade.counterAmount ?? 0) <= 0) {
        // eslint-disable-next-line no-await-in-loop
        await db.transactions.update(trade.id, {
          asset: 'SOL',
          amount: Math.abs(solFromSwap),
          contractAddress: WSOL,
          counterAsset: trade.asset,
          counterAmount: trade.amount,
          notes:
            trade.notes?.includes('SOL leg repaired')
              ? trade.notes
              : `${trade.notes ? `${trade.notes} · ` : ''}SOL leg repaired from on-chain balance`
        });
        updated++;
      }
    }
  }

  return updated;
}
