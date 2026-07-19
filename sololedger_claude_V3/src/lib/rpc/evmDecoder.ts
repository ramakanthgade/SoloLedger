import type { TxType } from '@/types/transaction';

export const ERC_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const ERC4626_DEPOSIT_TOPIC = '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7';

export interface EvmLogEntry { address: string; topics: string[]; data: string }
export interface EvmTxReceipt { transactionHash: string; logs: EvmLogEntry[]; to?: string; from?: string }
export interface EvmDecodeResult {
  type: TxType;
  asset?: string;
  amount?: number;
  rawAmount?: string;
  contractAddress?: string;
  counterpartyAddress?: string;
  notes?: string;
  confidence: 'high' | 'medium';
}
type KnownContract = { label: string; role: string };
export interface EvmTransferMatch {
  contractAddress?: string;
  direction: 'transfer_in' | 'transfer_out';
  from?: string;
  to?: string;
}

export const KNOWN_PROTOCOL_CONTRACTS: Record<string, KnownContract> = {
  '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9': { label: 'Aave V2 Lending Pool', role: 'deposit_target' },
  '0x87870bca3f3fd3275b3e2157b7c6c0d9fe57c4c': { label: 'Aave V3 Pool', role: 'deposit_target' },
  '0x25f2226b597e8f9514b3f68f00f494cf4f286491': { label: 'Aave Rewards Contract', role: 'rewards_source' },
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': { label: 'Uniswap V2 Router', role: 'router' },
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': { label: 'Uniswap V3 Router', role: 'router' },
  '0xba12222222228d8ba445958a75a0704d566bf2c8': { label: 'Balancer Vault', role: 'router' }
};
const TOKEN_META: Record<string, { symbol: string; decimals: number }> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': { symbol: 'UNI', decimals: 18 },
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': { symbol: 'AAVE', decimals: 18 }
};

function addressFromTopic(topic?: string): string | null {
  const clean = topic?.replace(/^0x/, '');
  return clean && clean.length === 64 ? `0x${clean.slice(24).toLowerCase()}` : null;
}
function uint256(hex: string): string | null {
  try {
    const clean = hex.replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{1,64}$/.test(clean)) return null;
    return BigInt(`0x${clean}`).toString();
  } catch { return null; }
}
function amountFor(raw: string, contract: string): number | undefined {
  const decimals = TOKEN_META[contract]?.decimals;
  if (decimals == null) return undefined;
  const amount = Number(raw) / 10 ** decimals;
  return Number.isFinite(amount) ? amount : undefined;
}

function decodeTransferLogs(receipt: EvmTxReceipt, walletAddress: string, extraContracts: Record<string, KnownContract>): EvmDecodeResult[] {
  const wallet = walletAddress.toLowerCase();
  const known = { ...KNOWN_PROTOCOL_CONTRACTS, ...Object.fromEntries(Object.entries(extraContracts).map(([k, v]) => [k.toLowerCase(), v])) };
  const results: EvmDecodeResult[] = [];
  for (const log of receipt.logs ?? []) {
    const topic = log.topics?.[0]?.toLowerCase();
    // ERC-20 has 3 topics. ERC-721 shares topic0 but has 4; avoid decoding tokenId as fungible amount.
    if (topic !== ERC_TRANSFER_TOPIC || log.topics.length !== 3) continue;
    const from = addressFromTopic(log.topics[1]);
    const to = addressFromTopic(log.topics[2]);
    const rawAmount = uint256(log.data);
    if (!from || !to || rawAmount == null || (from !== wallet && to !== wallet)) continue;
    const contract = log.address.toLowerCase();
    const metadata = TOKEN_META[contract];
    const base = {
      asset: metadata?.symbol,
      amount: amountFor(rawAmount, contract),
      rawAmount,
      contractAddress: contract,
      counterpartyAddress: to === wallet ? from : to,
      confidence: 'high' as const
    };
    if (to === wallet && known[from]?.role === 'rewards_source') {
      results.push({ ...base, type: 'income', notes: `${known[from].label} — possible rewards distribution` });
      continue;
    }
    if (from === wallet && known[to]?.role === 'deposit_target') {
      results.push({ ...base, type: 'defi_deposit', notes: `Deposit to ${known[to].label}` });
      continue;
    }
    if (from === wallet && known[to]?.role === 'router') {
      results.push({ ...base, type: 'trade', notes: `Swap via ${known[to].label}`, confidence: 'medium' });
      continue;
    }
    results.push({ ...base, type: to === wallet ? 'transfer_in' : 'transfer_out' });
  }
  return results;
}

export function decodeEvmReceipt(receipt: EvmTxReceipt, walletAddress: string, extraContracts: Record<string, KnownContract> = {}): EvmDecodeResult | null {
  return decodeTransferLogs(receipt, walletAddress, extraContracts)[0] ?? null;
}

/** Decode only the receipt leg represented by one Alchemy transfer row. */
export function decodeEvmReceiptForTransfer(
  receipt: EvmTxReceipt,
  walletAddress: string,
  match: EvmTransferMatch,
  extraContracts: Record<string, KnownContract> = {}
): EvmDecodeResult | null {
  const contract = match.contractAddress?.toLowerCase();
  const from = match.from?.toLowerCase();
  const to = match.to?.toLowerCase();
  return decodeTransferLogs(receipt, walletAddress, extraContracts).find((decoded) => {
    if (contract && decoded.contractAddress !== contract) return false;
    if (decoded.type === 'transfer_in' || decoded.type === 'income') {
      if (match.direction !== 'transfer_in') return false;
      return (!from || decoded.counterpartyAddress === from) && (!to || to === walletAddress.toLowerCase());
    }
    if (match.direction !== 'transfer_out') return false;
    return (!to || decoded.counterpartyAddress === to) && (!from || from === walletAddress.toLowerCase());
  }) ?? null;
}

export async function fetchEvmTransactionReceipt(
  rpcUrl: string,
  txHash: string,
  headers: HeadersInit = { 'Content-Type': 'application/json' }
): Promise<EvmTxReceipt | null> {
  try {
    const response = await fetch(rpcUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }) });
    if (!response.ok) return null;
    const json = await response.json();
    const result = json?.result;
    if (!result || !Array.isArray(result.logs)) return null;
    return { transactionHash: result.transactionHash, from: result.from, to: result.to, logs: result.logs };
  } catch { return null; }
}

export async function decodeEvmTxByHash(
  rpcUrl: string,
  txHash: string,
  walletAddress: string,
  extraContracts?: Record<string, KnownContract>,
  headers: HeadersInit = { 'Content-Type': 'application/json' }
): Promise<EvmDecodeResult | null> {
  const receipt = await fetchEvmTransactionReceipt(rpcUrl, txHash, headers);
  return receipt ? decodeEvmReceipt(receipt, walletAddress, extraContracts) : null;
}

export function isKnownProtocolContract(address: string, extraContracts: Record<string, KnownContract> = {}): KnownContract | null {
  return KNOWN_PROTOCOL_CONTRACTS[address.toLowerCase()] ?? extraContracts[address.toLowerCase()] ?? null;
}
