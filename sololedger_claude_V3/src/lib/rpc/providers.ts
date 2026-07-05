/**
 * Wallet lookup providers. Design goal: as few keys as possible, and pull
 * everything at an address — native asset, every token/NFT it holds or has
 * moved, not just the chain's native coin.
 *
 * - Bitcoin uses Blockstream/mempool.space-compatible APIs — free, no key,
 *   no account. Every such service still sees the address you query; there
 *   is no way around that for any hosted explorer (see Settings for why).
 * - Every other chain here goes through Alchemy, because one free Alchemy
 *   API key covers Ethereum, Polygon, Arbitrum, Base, BNB Smart Chain,
 *   Optimism, Avalanche, AND Solana.
 * - Etherscan-compatible is kept as a manual fallback.
 */
import { makeId } from '@/lib/parsers/types';
import type { Transaction } from '@/types/transaction';

export type ChainId = 'bitcoin' | 'ethereum' | 'polygon' | 'arbitrum' | 'base' | 'bsc' | 'optimism' | 'avalanche' | 'solana' | 'custom_evm';

export interface ChainDef {
  id: ChainId;
  label: string;
  asset: string;
  provider: 'blockstream' | 'alchemy_evm' | 'alchemy_solana' | 'etherscan_compatible';
  alchemyNetwork?: string; // Alchemy's network slug, e.g. "eth-mainnet"
  needsKey: boolean;
}

export const CHAINS: ChainDef[] = [
  { id: 'bitcoin', label: 'Bitcoin', asset: 'BTC', provider: 'blockstream', needsKey: false },
  { id: 'ethereum', label: 'Ethereum', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'eth-mainnet', needsKey: true },
  { id: 'polygon', label: 'Polygon', asset: 'MATIC', provider: 'alchemy_evm', alchemyNetwork: 'polygon-mainnet', needsKey: true },
  { id: 'arbitrum', label: 'Arbitrum', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'arb-mainnet', needsKey: true },
  { id: 'base', label: 'Base', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'base-mainnet', needsKey: true },
  { id: 'optimism', label: 'Optimism', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'opt-mainnet', needsKey: true },
  { id: 'bsc', label: 'BNB Smart Chain', asset: 'BNB', provider: 'alchemy_evm', alchemyNetwork: 'bnb-mainnet', needsKey: true },
  { id: 'avalanche', label: 'Avalanche C-Chain', asset: 'AVAX', provider: 'alchemy_evm', alchemyNetwork: 'avax-mainnet', needsKey: true },
  { id: 'solana', label: 'Solana', asset: 'SOL', provider: 'alchemy_solana', alchemyNetwork: 'solana-mainnet', needsKey: true },
  { id: 'custom_evm', label: 'Other EVM chain (Etherscan-compatible)', asset: '', provider: 'etherscan_compatible', needsKey: true }
];

/** CoinGecko "asset platform" slugs, for contract-address price lookups. */
export const COINGECKO_PLATFORM: Partial<Record<ChainId, string>> = {
  ethereum: 'ethereum',
  polygon: 'polygon-pos',
  arbitrum: 'arbitrum-one',
  base: 'base',
  optimism: 'optimistic-ethereum',
  bsc: 'binance-smart-chain',
  avalanche: 'avalanche',
  solana: 'solana'
};

export interface LookupWarning {
  address: string;
  message: string;
}

export interface LookupResult {
  transactions: Transaction[];
  warnings: LookupWarning[];
}

// ---- Bitcoin: Blockstream/mempool.space-compatible, no key ----
async function fetchBitcoin(address: string, baseUrl: string, asset: string): Promise<LookupResult> {
  const res = await fetch(`${baseUrl}/address/${address}/txs`);
  if (!res.ok) throw new Error(`Explorer API returned ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return { transactions: [], warnings: [{ address, message: 'Unexpected response shape.' }] };

  const transactions: Transaction[] = data.map((row: any) => {
    const isOutgoing = row.vin?.some((v: any) => v.prevout?.scriptpubkey_address === address);
    const totalOut = (row.vout || []).reduce(
      (s: number, o: any) => (o.scriptpubkey_address === address ? s + o.value : s),
      0
    );
    // Best-effort single counterparty: the other address involved, if there's exactly one.
    const otherAddresses = new Set<string>();
    for (const v of row.vin ?? []) if (v.prevout?.scriptpubkey_address && v.prevout.scriptpubkey_address !== address) otherAddresses.add(v.prevout.scriptpubkey_address);
    for (const o of row.vout ?? []) if (o.scriptpubkey_address && o.scriptpubkey_address !== address) otherAddresses.add(o.scriptpubkey_address);
    const counterparty = otherAddresses.size === 1 ? [...otherAddresses][0] : undefined;

    return {
      id: makeId('rpc'),
      timestamp: (row.status?.block_time ?? Date.now() / 1000) * 1000,
      type: isOutgoing ? 'transfer_out' : 'transfer_in',
      asset,
      amount: totalOut / 1e8,
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:blockstream',
      sourceRef: row.txid,
      walletAddress: address,
      counterpartyAddress: counterparty,
      chain: 'bitcoin',
      flags: ['possible_internal_transfer', 'missing_cost_basis'] as const,
      isInternalTransfer: false,
      raw: row
    } as Transaction;
  });

  return { transactions, warnings: [] };
}

function alchemyRpcUrl(network: string): string {
  // When running via `npm run dev` / `npm run preview` on localhost, route through
  // Vite's same-origin proxy (see vite.config.ts). Direct browser → Alchemy calls
  // are blocked by CORS for some methods (e.g. alchemy_getAssetTransfers).
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return `/alchemy-rpc/${network}`;
    }
  }
  return `https://${network}.g.alchemy.com/v2`;
}

function alchemyErrorMessage(status: number, body?: { error?: { code?: number; message?: string } }): string {
  if (status === 429 || body?.error?.code === 429) {
    return (
      'Alchemy transfer lookup is rate-limited on the free plan (this can last hours during high traffic). ' +
      'Add a free Etherscan API key in Settings — it is used automatically as a fallback for Ethereum and other EVM chains. ' +
      'Get one at etherscan.io/apis'
    );
  }
  if (body?.error?.message) return body.error.message;
  return `Alchemy API returned ${status} — check your API key`;
}

/** Etherscan multichain API v2 chain ids (one key covers all). */
const ETHERSCAN_V2_CHAIN_IDS: Partial<Record<ChainId, number>> = {
  ethereum: 1,
  polygon: 137,
  arbitrum: 42161,
  base: 8453,
  optimism: 10,
  bsc: 56,
  avalanche: 43114
};

function etherscanV2BaseUrl(chainId: ChainId): string | null {
  const id = ETHERSCAN_V2_CHAIN_IDS[chainId];
  return id != null ? `https://api.etherscan.io/v2/api?chainid=${id}` : null;
}

function isAlchemyRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('rate limit') || msg.includes('429') || msg.toLowerCase().includes('rate-limited');
}

function alchemyHeaders(apiKey: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
}

// ---- EVM chains via Alchemy's alchemy_getAssetTransfers (native + ERC20 + NFTs) ----
async function fetchAlchemyEvmInner(
  address: string,
  network: string,
  apiKey: string,
  asset: string,
  chainId: ChainId
): Promise<LookupResult> {
  const url = alchemyRpcUrl(network);
  const body = (direction: 'from' | 'to') => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'alchemy_getAssetTransfers',
    params: [
      {
        [direction === 'from' ? 'fromAddress' : 'toAddress']: address,
        category: ['external', 'erc20', 'erc721', 'erc1155'],
        withMetadata: true,
        excludeZeroValue: true,
        maxCount: '0x64'
      }
    ]
  });

  const headers = alchemyHeaders(apiKey);
  const [outgoingRes, incomingRes] = await Promise.all([
    fetch(url, { method: 'POST', headers, body: JSON.stringify(body('from')) }),
    fetch(url, { method: 'POST', headers, body: JSON.stringify(body('to')) })
  ]);

  const [outgoing, incoming] = await Promise.all([outgoingRes.json(), incomingRes.json()]);
  if (!outgoingRes.ok || !incomingRes.ok) {
    const status = outgoingRes.ok ? incomingRes.status : outgoingRes.status;
    throw new Error(alchemyErrorMessage(status, outgoing.error ? outgoing : incoming));
  }
  if (outgoing.error || incoming.error) {
    const err = outgoing.error ?? incoming.error;
    throw new Error(alchemyErrorMessage(err?.code ?? 0, { error: err }));
  }

  const toTx = (t: any, direction: 'transfer_out' | 'transfer_in'): Transaction => {
    const isNft = t.category === 'erc721' || t.category === 'erc1155';
    return {
      id: makeId('rpc'),
      timestamp: t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).getTime() : Date.now(),
      type: direction,
      asset: t.asset || (isNft ? (t.rawContract?.address ? `NFT ${String(t.rawContract.address).slice(0, 6)}` : 'NFT') : asset),
      amount: isNft ? (t.erc1155Metadata?.[0]?.value ? Number(t.erc1155Metadata[0].value) : 1) : Number(t.value) || 0,
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:alchemy',
      sourceRef: t.hash,
      walletAddress: address,
      counterpartyAddress: direction === 'transfer_in' ? t.from : t.to,
      contractAddress: t.rawContract?.address || undefined,
      chain: chainId,
      flags: ['possible_internal_transfer', 'missing_cost_basis'],
      isInternalTransfer: false,
      raw: t
    };
  };

  const transactions = [
    ...(outgoing.result?.transfers ?? []).map((t: any) => toTx(t, 'transfer_out')),
    ...(incoming.result?.transfers ?? []).map((t: any) => toTx(t, 'transfer_in'))
  ];

  return { transactions, warnings: [] };
}

async function fetchAlchemyEvm(
  address: string,
  network: string,
  apiKey: string,
  asset: string,
  chainId: ChainId,
  etherscanApiKey?: string
): Promise<LookupResult> {
  try {
    return await fetchAlchemyEvmInner(address, network, apiKey, asset, chainId);
  } catch (err) {
    if (!isAlchemyRateLimitError(err)) throw err;
    const baseUrl = etherscanV2BaseUrl(chainId);
    if (etherscanApiKey && baseUrl) {
      const result = await fetchEtherscanCompatible(address, baseUrl, etherscanApiKey, asset);
      return {
        transactions: result.transactions,
        warnings: [
          {
            address,
            message:
              'Alchemy transfer lookup was rate-limited; fetched via Etherscan instead (native + ERC-20 transfers).'
          },
          ...result.warnings
        ]
      };
    }
    throw err;
  }
}

// ---- Solana via Alchemy's Solana RPC + DAS (native SOL, SPL tokens, and NFTs) ----
const solanaAssetCache = new Map<string, { symbol: string; isNft: boolean }>();

async function getSolanaAssetMeta(apiKey: string, mint: string): Promise<{ symbol: string; isNft: boolean }> {
  if (solanaAssetCache.has(mint)) return solanaAssetCache.get(mint)!;
  try {
    const res = await fetch(alchemyRpcUrl('solana-mainnet'), {
      method: 'POST',
      headers: alchemyHeaders(apiKey),
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

async function fetchAlchemySolana(address: string, apiKey: string): Promise<LookupResult> {
  const url = alchemyRpcUrl('solana-mainnet');
  const headers = alchemyHeaders(apiKey);

  const sigRes = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [address, { limit: 50 }] })
  });
  const sigData = await sigRes.json();
  if (!sigRes.ok) throw new Error(alchemyErrorMessage(sigRes.status, sigData));
  if (sigData.error) throw new Error(alchemyErrorMessage(sigData.error.code ?? 0, sigData));
  const signatures: { signature: string; blockTime: number | null }[] = sigData.result ?? [];

  if (signatures.length === 0) return { transactions: [], warnings: [] };

  const transactions: Transaction[] = [];

  for (const sig of signatures) {
    // eslint-disable-next-line no-await-in-loop
    const txRes = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig.signature, { maxSupportedTransactionVersion: 0 }] })
    });
    // eslint-disable-next-line no-await-in-loop
    const txData = await txRes.json();
    const tx = txData.result;
    if (!tx) continue;
    const timestamp = (sig.blockTime ?? Date.now() / 1000) * 1000;

    // --- Native SOL balance delta ---
    const accountKeys: string[] = tx.transaction?.message?.accountKeys?.map((k: any) => (typeof k === 'string' ? k : k.pubkey)) ?? [];
    const idx = accountKeys.indexOf(address);
    if (idx !== -1) {
      const pre = tx.meta?.preBalances?.[idx] ?? 0;
      const post = tx.meta?.postBalances?.[idx] ?? 0;
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

    // --- SPL token / NFT balance deltas (USDC, other tokens, NFTs) ---
    const pre = (tx.meta?.preTokenBalances ?? []).filter((b: any) => b.owner === address);
    const post = (tx.meta?.postTokenBalances ?? []).filter((b: any) => b.owner === address);
    const mints = new Set<string>([...pre.map((b: any) => b.mint), ...post.map((b: any) => b.mint)]);

    // eslint-disable-next-line no-await-in-loop
    for (const mint of mints) {
      const preAmt = pre.find((b: any) => b.mint === mint)?.uiTokenAmount?.uiAmount ?? 0;
      const postAmt = post.find((b: any) => b.mint === mint)?.uiTokenAmount?.uiAmount ?? 0;
      const delta = postAmt - preAmt;
      if (Math.abs(delta) < 1e-9) continue;

      // eslint-disable-next-line no-await-in-loop
      const meta = await getSolanaAssetMeta(apiKey, mint);
      transactions.push({
        id: makeId('rpc'),
        timestamp,
        type: delta > 0 ? 'transfer_in' : 'transfer_out',
        asset: meta.symbol,
        amount: Math.abs(delta),
        fiatCurrency: 'USD',
        fiatValue: undefined,
        source: 'rpc:alchemy',
        sourceRef: sig.signature,
        walletAddress: address,
        contractAddress: mint,
        chain: 'solana',
        category: meta.isNft ? 'nft' : undefined,
        flags: ['possible_internal_transfer', 'missing_cost_basis'],
        isInternalTransfer: false,
        raw: tx
      });
    }
  }

  return { transactions, warnings: [] };
}

// ---- Generic Etherscan-compatible fallback (BYO key/endpoint) ----
function etherscanRequestUrl(baseUrl: string, params: Record<string, string>, apiKey: string): string {
  const qs = new URLSearchParams({ ...params, apikey: apiKey });
  const sep = baseUrl.includes('?') ? '&' : '?';
  let url = `${baseUrl}${sep}${qs.toString()}`;
  // Same-origin proxy in dev avoids browser CORS blocks on explorer APIs.
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if ((host === 'localhost' || host === '127.0.0.1') && url.startsWith('https://api.etherscan.io')) {
      url = url.replace('https://api.etherscan.io', '/etherscan-api');
    }
  }
  return url;
}

async function fetchEtherscanCompatible(address: string, baseUrl: string, apiKey: string, asset: string): Promise<LookupResult> {
  if (!apiKey?.trim()) {
    throw new Error('Add a free Etherscan API key in Settings (etherscan.io/apis).');
  }

  const commonParams = {
    module: 'account',
    address,
    startblock: '0',
    endblock: '99999999',
    page: '1',
    offset: '1000',
    sort: 'desc'
  };
  const nativeUrl = etherscanRequestUrl(baseUrl, { ...commonParams, action: 'txlist' }, apiKey);
  const tokenUrl = etherscanRequestUrl(baseUrl, { ...commonParams, action: 'tokentx' }, apiKey);

  function toEtherscanTx(row: Record<string, string>, addr: string, nativeAsset: string, isToken: boolean): Transaction {
    const decimals = isToken ? Number(row.tokenDecimal || '18') : 18;
    const valueRaw = BigInt(row.value || '0');
    const amount = Number(valueRaw) / 10 ** decimals;
    const isOutgoing = row.from?.toLowerCase() === addr.toLowerCase();
    return {
      id: makeId('rpc'),
      timestamp: Number(row.timeStamp) * 1000,
      type: isOutgoing ? 'transfer_out' : 'transfer_in',
      asset: isToken ? row.tokenSymbol || 'TOKEN' : nativeAsset,
      amount,
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:etherscan_compatible',
      sourceRef: row.hash,
      walletAddress: addr,
      counterpartyAddress: isOutgoing ? row.to : row.from,
      contractAddress: isToken ? row.contractAddress : undefined,
      flags: ['possible_internal_transfer', 'missing_cost_basis'] as const,
      isInternalTransfer: false,
      raw: row
    } as Transaction;
  }

  const parseExplorerError = async (res: Response): Promise<string> => {
    try {
      const data = await res.json();
      const detail = typeof data?.result === 'string' ? data.result : data?.message;
      return detail || `Explorer API returned ${res.status}`;
    } catch {
      return `Explorer API returned ${res.status}`;
    }
  };

  const nativeRes = await fetch(nativeUrl);
  if (!nativeRes.ok) throw new Error(await parseExplorerError(nativeRes));
  const nativeData = await nativeRes.json();

  const tokenRes = await fetch(tokenUrl);
  const tokenData = tokenRes.ok ? await tokenRes.json() : { status: '0', result: [] };
  if (!tokenRes.ok) {
    // Token history is optional — native txs are still useful.
    const tokenErr = await parseExplorerError(tokenRes);
    const warnings: LookupWarning[] = [{ address, message: `Token transfer fetch failed: ${tokenErr}` }];
    const transactions: Transaction[] = Array.isArray(nativeData.result)
      ? nativeData.result.map((r: any) => toEtherscanTx(r, address, asset, false))
      : [];
    return { transactions, warnings };
  }

  const warnings: LookupWarning[] = [];
  if (nativeData.status !== '1' || !Array.isArray(nativeData.result)) {
    const detail = typeof nativeData.result === 'string' ? nativeData.result : nativeData.message;
    throw new Error(detail || 'Etherscan returned no native transactions for this address.');
  }

  const transactions: Transaction[] = [
    ...nativeData.result.map((r: any) => toEtherscanTx(r, address, asset, false)),
    ...(Array.isArray(tokenData.result) ? tokenData.result.map((r: any) => toEtherscanTx(r, address, asset, true)) : [])
  ];

  return { transactions, warnings };
}

export interface LookupConfig {
  chain: ChainDef;
  alchemyApiKey?: string;
  customBaseUrl?: string;
  customApiKey?: string;
  customAsset?: string;
}

async function lookupOneAddress(address: string, config: LookupConfig): Promise<LookupResult> {
  const { chain } = config;
  if (chain.provider === 'blockstream') {
    return fetchBitcoin(address, 'https://blockstream.info/api', chain.asset);
  }
  if (chain.provider === 'alchemy_evm') {
    if (!config.alchemyApiKey) throw new Error('Add your Alchemy API key in Settings first.');
    return fetchAlchemyEvm(
      address,
      chain.alchemyNetwork!,
      config.alchemyApiKey,
      chain.asset,
      chain.id,
      config.customApiKey
    );
  }
  if (chain.provider === 'alchemy_solana') {
    if (!config.alchemyApiKey) throw new Error('Add your Alchemy API key in Settings first.');
    return fetchAlchemySolana(address, config.alchemyApiKey);
  }
  if (!config.customBaseUrl) throw new Error('Enter an explorer base URL.');
  return fetchEtherscanCompatible(address, config.customBaseUrl, config.customApiKey ?? '', config.customAsset || 'TOKEN');
}

/**
 * Looks up many addresses on one chain in one job. Paces requests slightly
 * so a batch of addresses doesn't burst past free-tier rate limits.
 */
export async function lookupManyAddresses(
  addresses: string[],
  config: LookupConfig,
  onProgress?: (done: number, total: number) => void
): Promise<{
  transactions: Transaction[];
  warnings: LookupWarning[];
  failed: LookupWarning[];
  perAddress: { address: string; count: number }[];
}> {
  const transactions: Transaction[] = [];
  const warnings: LookupWarning[] = [];
  const failed: LookupWarning[] = [];
  const perAddress: { address: string; count: number }[] = [];

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i].trim();
    if (!address) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await lookupOneAddress(address, config);
      transactions.push(...result.transactions);
      warnings.push(...result.warnings);
      perAddress.push({ address, count: result.transactions.length });
    } catch (err) {
      failed.push({ address, message: err instanceof Error ? err.message : 'Lookup failed.' });
    }
    onProgress?.(i + 1, addresses.length);
    // eslint-disable-next-line no-await-in-loop
    if (i < addresses.length - 1) await new Promise((r) => setTimeout(r, 400));
  }

  return { transactions, warnings, failed, perAddress };
}
