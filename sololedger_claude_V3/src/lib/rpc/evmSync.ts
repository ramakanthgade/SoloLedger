import { makeId } from '@/lib/parsers/types';
import type { Transaction } from '@/types/transaction';
import type { ChainId, LookupResult } from '@/lib/rpc/providers';

export interface EvmSyncOptions {
  mode: 'incremental' | 'full';
  knownHashes?: Set<string>;
  onProgress?: (transfersProcessed: number) => void;
}

export interface EvmSyncResult extends LookupResult {
  newestCursor?: string;
}

async function fetchTransferPage(
  url: string,
  address: string,
  direction: 'from' | 'to',
  pageKey?: string
): Promise<{ transfers: unknown[]; pageKey?: string }> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'alchemy_getAssetTransfers',
    params: [
      {
        [direction === 'from' ? 'fromAddress' : 'toAddress']: address,
        category: ['external', 'erc20', 'erc721', 'erc1155'],
        withMetadata: true,
        excludeZeroValue: true,
        maxCount: '0x3e8',
        ...(pageKey ? { pageKey } : {})
      }
    ]
  };

  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Alchemy API returned ${res.status} — check your API key`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Alchemy API error');
  return { transfers: data.result?.transfers ?? [], pageKey: data.result?.pageKey };
}

function toEvmTx(t: Record<string, unknown>, direction: 'transfer_out' | 'transfer_in', address: string, asset: string, chainId: ChainId): Transaction {
  const isNft = t.category === 'erc721' || t.category === 'erc1155';
  const metadata = t.metadata as { blockTimestamp?: string } | undefined;
  const rawContract = t.rawContract as { address?: string } | undefined;
  const erc1155 = t.erc1155Metadata as { value?: string }[] | undefined;
  return {
    id: makeId('rpc'),
    timestamp: metadata?.blockTimestamp ? new Date(metadata.blockTimestamp).getTime() : Date.now(),
    type: direction,
    asset: (t.asset as string) || (isNft ? (rawContract?.address ? `NFT ${String(rawContract.address).slice(0, 6)}` : 'NFT') : asset),
    amount: isNft ? (erc1155?.[0]?.value ? Number(erc1155[0].value) : 1) : Number(t.value) || 0,
    fiatCurrency: 'USD',
    fiatValue: undefined,
    source: 'rpc:alchemy',
    sourceRef: t.hash as string,
    walletAddress: address,
    counterpartyAddress: direction === 'transfer_in' ? (t.from as string) : (t.to as string),
    contractAddress: rawContract?.address || undefined,
    chain: chainId,
    flags: ['possible_internal_transfer', 'missing_cost_basis'],
    isInternalTransfer: false,
    raw: t
  };
}

async function fetchDirection(
  url: string,
  address: string,
  direction: 'from' | 'to',
  asset: string,
  chainId: ChainId,
  options: EvmSyncOptions
): Promise<{ transactions: Transaction[]; newestCursor?: string }> {
  const transactions: Transaction[] = [];
  let pageKey: string | undefined;
  let newestCursor: string | undefined;
  let processed = 0;
  let stop = false;

  while (!stop) {
    const page = await fetchTransferPage(url, address, direction, pageKey);
    if (page.transfers.length === 0) break;

    for (const raw of page.transfers) {
      const t = raw as Record<string, unknown>;
      const hash = t.hash as string;
      if (!newestCursor && hash) newestCursor = hash;

      if (options.mode === 'incremental' && options.knownHashes?.has(hash)) {
        stop = true;
        continue;
      }

      transactions.push(toEvmTx(t, direction === 'from' ? 'transfer_out' : 'transfer_in', address, asset, chainId));
      processed += 1;
      options.onProgress?.(processed);
    }

    if (!page.pageKey || stop) break;
    pageKey = page.pageKey;
  }

  return { transactions, newestCursor };
}

export async function syncEvmWallet(
  address: string,
  network: string,
  apiKey: string,
  asset: string,
  chainId: ChainId,
  options: EvmSyncOptions
): Promise<EvmSyncResult> {
  const url = `https://${network}.g.alchemy.com/v2/${apiKey}`;
  const [outgoing, incoming] = await Promise.all([
    fetchDirection(url, address, 'from', asset, chainId, options),
    fetchDirection(url, address, 'to', asset, chainId, options)
  ]);

  const transactions = [...outgoing.transactions, ...incoming.transactions];
  const newestCursor = outgoing.newestCursor ?? incoming.newestCursor;

  return { transactions, warnings: [], newestCursor };
}
