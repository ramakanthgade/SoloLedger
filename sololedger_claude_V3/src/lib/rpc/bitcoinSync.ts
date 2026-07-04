import type { Transaction } from '@/types/transaction';
import type { LookupResult } from '@/lib/rpc/providers';

export interface BitcoinSyncOptions {
  mode: 'incremental' | 'full';
  untilCursor?: string;
  onProgress?: (txsProcessed: number) => void;
}

export interface BitcoinSyncResult extends LookupResult {
  newestCursor?: string;
}

function parseBitcoinTx(row: Record<string, unknown>, address: string, asset: string): Transaction {
  const vin = row.vin as { prevout?: { scriptpubkey_address?: string } }[] | undefined;
  const vout = row.vout as { scriptpubkey_address?: string; value?: number }[] | undefined;
  const isOutgoing = vin?.some((v) => v.prevout?.scriptpubkey_address === address);
  const totalOut = (vout ?? []).reduce((s, o) => (o.scriptpubkey_address === address ? s + (o.value ?? 0) : s), 0);
  const otherAddresses = new Set<string>();
  for (const v of vin ?? []) {
    if (v.prevout?.scriptpubkey_address && v.prevout.scriptpubkey_address !== address) {
      otherAddresses.add(v.prevout.scriptpubkey_address);
    }
  }
  for (const o of vout ?? []) {
    if (o.scriptpubkey_address && o.scriptpubkey_address !== address) otherAddresses.add(o.scriptpubkey_address);
  }
  const counterparty = otherAddresses.size === 1 ? [...otherAddresses][0] : undefined;
  const status = row.status as { block_time?: number } | undefined;

  return {
    id: `rpc_bitcoin_${address}_${row.txid}_${isOutgoing ? 'out' : 'in'}_${totalOut}`,
    timestamp: (status?.block_time ?? Date.now() / 1000) * 1000,
    type: isOutgoing ? 'transfer_out' : 'transfer_in',
    asset,
    amount: totalOut / 1e8,
    fiatCurrency: 'USD',
    fiatValue: undefined,
    source: 'rpc:blockstream',
    sourceRef: row.txid as string,
    walletAddress: address,
    counterpartyAddress: counterparty,
    chain: 'bitcoin',
    flags: ['possible_internal_transfer', 'missing_cost_basis'],
    isInternalTransfer: false,
    raw: row
  };
}

export async function syncBitcoinWallet(
  address: string,
  asset: string,
  options: BitcoinSyncOptions
): Promise<BitcoinSyncResult> {
  const baseUrl = 'https://blockstream.info/api';
  const transactions: Transaction[] = [];
  let newestCursor: string | undefined;
  let processed = 0;
  let path = `${baseUrl}/address/${address}/txs`;

  while (path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Explorer API returned ${res.status}`);
    const batch = (await res.json()) as Record<string, unknown>[];
    if (!Array.isArray(batch) || batch.length === 0) break;

    if (!newestCursor && batch[0]?.txid) newestCursor = batch[0].txid as string;

    for (const row of batch) {
      const txid = row.txid as string;
      if (options.mode === 'incremental' && options.untilCursor && txid === options.untilCursor) {
        return { transactions, warnings: [], newestCursor };
      }
      transactions.push(parseBitcoinTx(row, address, asset));
      processed += 1;
      options.onProgress?.(processed);
    }

    if (options.mode === 'incremental' && options.untilCursor && batch.some((r) => r.txid === options.untilCursor)) {
      break;
    }

    const lastTxid = batch[batch.length - 1]?.txid as string | undefined;
    if (!lastTxid || batch.length < 25) break;
    path = `${baseUrl}/address/${address}/txs/chain/${lastTxid}`;
  }

  return { transactions, warnings: [], newestCursor };
}
