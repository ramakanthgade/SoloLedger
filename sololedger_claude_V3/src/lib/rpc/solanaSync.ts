import { makeId } from '@/lib/parsers/types';
import type { Transaction } from '@/types/transaction';
import type { LookupResult } from '@/lib/rpc/providers';

const SOLANA_KNOWN_MINTS: Record<string, { symbol: string; isNft?: boolean }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC' },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT' },
  So11111111111111111111111111111111111111112: { symbol: 'SOL' },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: 'mSOL' },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { symbol: 'JitoSOL' },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: 'BONK' },
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': { symbol: 'stSOL' }
};

const solanaAssetCache = new Map<string, { symbol: string; isNft: boolean }>();

async function getSolanaAssetMeta(url: string, mint: string): Promise<{ symbol: string; isNft: boolean }> {
  const known = SOLANA_KNOWN_MINTS[mint];
  if (known) {
    const meta = { symbol: known.symbol, isNft: known.isNft ?? false };
    solanaAssetCache.set(mint, meta);
    return meta;
  }
  if (solanaAssetCache.has(mint)) return solanaAssetCache.get(mint)!;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } })
    });
    const data = await res.json();
    const asset = data.result;
    const symbol = asset?.content?.metadata?.symbol || asset?.token_info?.symbol || `${mint.slice(0, 4)}…${mint.slice(-4)}`;
    const isNft = !!asset?.interface && asset.interface !== 'FungibleToken' && asset.interface !== 'FungibleAsset';
    const meta = { symbol, isNft };
    solanaAssetCache.set(mint, meta);
    return meta;
  } catch {
    const meta = { symbol: `${mint.slice(0, 4)}…${mint.slice(-4)}`, isNft: false };
    solanaAssetCache.set(mint, meta);
    return meta;
  }
}

export interface SolanaSyncOptions {
  mode: 'incremental' | 'full';
  /** Stop when this signature is reached (already synced). */
  untilCursor?: string;
  onProgress?: (signaturesProcessed: number) => void;
}

export interface SolanaSyncResult extends LookupResult {
  newestCursor?: string;
  signaturesFetched: number;
}

async function parseSolanaTransaction(
  url: string,
  address: string,
  sig: { signature: string; blockTime: number | null },
  tx: Record<string, unknown>
): Promise<Transaction[]> {
  const timestamp = (sig.blockTime ?? Date.now() / 1000) * 1000;
  const transactions: Transaction[] = [];

  const accountKeys: string[] =
    (tx.transaction as { message?: { accountKeys?: unknown[] } })?.message?.accountKeys?.map((k: unknown) =>
      typeof k === 'string' ? k : (k as { pubkey: string }).pubkey
    ) ?? [];
  const idx = accountKeys.indexOf(address);
  if (idx !== -1) {
    const meta = tx.meta as { preBalances?: number[]; postBalances?: number[] } | undefined;
    const pre = meta?.preBalances?.[idx] ?? 0;
    const post = meta?.postBalances?.[idx] ?? 0;
    const delta = (post - pre) / 1e9;
    if (Math.abs(delta) > 0.000001) {
      transactions.push({
        id: makeId('rpc'),
        timestamp,
        type: delta > 0 ? 'transfer_in' : 'transfer_out',
        asset: 'SOL',
        amount: Math.abs(delta),
        fiatCurrency: 'USD',
        fiatValue: undefined,
        source: 'rpc:alchemy',
        sourceRef: sig.signature,
        walletAddress: address,
        chain: 'solana',
        flags: ['possible_internal_transfer', 'missing_cost_basis'],
        isInternalTransfer: false,
        raw: tx
      });
    }
  }

  type TokenBal = { owner?: string; mint: string; uiTokenAmount?: { uiAmount?: number } };
  const txMeta = tx.meta as { preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | undefined;
  const pre = (txMeta?.preTokenBalances ?? []).filter((b) => b.owner === address);
  const post = (txMeta?.postTokenBalances ?? []).filter((b) => b.owner === address);
  const mints = new Set<string>([...pre.map((b) => b.mint), ...post.map((b) => b.mint)]);

  for (const mint of mints) {
    const preAmt = pre.find((b) => b.mint === mint)?.uiTokenAmount?.uiAmount ?? 0;
    const postAmt = post.find((b) => b.mint === mint)?.uiTokenAmount?.uiAmount ?? 0;
    const delta = postAmt - preAmt;
    if (Math.abs(delta) < 1e-9) continue;

    const assetMeta = await getSolanaAssetMeta(url, mint);
    transactions.push({
      id: makeId('rpc'),
      timestamp,
      type: delta > 0 ? 'transfer_in' : 'transfer_out',
      asset: assetMeta.symbol,
      amount: Math.abs(delta),
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:alchemy',
      sourceRef: sig.signature,
      walletAddress: address,
      contractAddress: mint,
      chain: 'solana',
      category: assetMeta.isNft ? 'nft' : undefined,
      flags: ['possible_internal_transfer', 'missing_cost_basis'],
      isInternalTransfer: false,
      raw: tx
    });
  }

  return transactions;
}

export async function syncSolanaWallet(
  address: string,
  apiKey: string,
  options: SolanaSyncOptions
): Promise<SolanaSyncResult> {
  const url = `https://solana-mainnet.g.alchemy.com/v2/${apiKey}`;
  const transactions: Transaction[] = [];
  let before: string | undefined;
  let signaturesFetched = 0;
  let newestCursor: string | undefined;
  let hitCursor = false;

  while (!hitCursor) {
    const params: { limit: number; before?: string } = { limit: 1000 };
    if (before) params.before = before;

    const sigRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [address, params] })
    });
    if (!sigRes.ok) throw new Error(`Alchemy API returned ${sigRes.status} — check your API key`);
    const sigData = await sigRes.json();
    if (sigData.error) throw new Error(sigData.error.message || 'Alchemy API error');

    const batch: { signature: string; blockTime: number | null }[] = sigData.result ?? [];
    if (batch.length === 0) break;

    if (!newestCursor) newestCursor = batch[0].signature;

    for (const sig of batch) {
      if (options.mode === 'incremental' && options.untilCursor && sig.signature === options.untilCursor) {
        hitCursor = true;
        break;
      }

      const txRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [sig.signature, { maxSupportedTransactionVersion: 0 }]
        })
      });
      const txData = await txRes.json();
      const tx = txData.result;
      if (tx) {
        const parsed = await parseSolanaTransaction(url, address, sig, tx);
        transactions.push(...parsed);
      }

      signaturesFetched += 1;
      options.onProgress?.(signaturesFetched);
    }

    if (options.mode === 'incremental' && options.untilCursor && batch.some((s) => s.signature === options.untilCursor)) {
      hitCursor = true;
    }

    if (batch.length < 1000) break;
    before = batch[batch.length - 1].signature;
  }

  return { transactions, warnings: [], newestCursor, signaturesFetched };
}
