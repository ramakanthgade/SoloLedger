/**
 * Noves Translate API client for DeFi transaction classification.
 * Noves decodes on-chain smart contract interactions and returns structured
 * data with a transaction type (swap, stakeDeposit, claimRewards, etc.)
 * and labelled asset flows — so we never need to write protocol-specific code.
 *
 * Docs: https://docs.noves.fi
 * Base URL: https://translate.noves.fi
 * Auth: apiKey header
 *
 * Costs (from docs):
 *   EVM /tx: 25 CU each
 *   SVM /tx: 10 CU each
 * Starter plan: 300k CU free, then ~$250/mo for 20M CU.
 */
import type { TxType } from '@/types/transaction';
import { isSaasMode } from '@/lib/saas/config';
import { saasProxyFetch } from '@/lib/saas/api';

const NOVES_BASE = 'https://translate.noves.fi';

/** SoloLedger chain id → Noves EVM chain slug */
const NOVES_EVM_CHAIN: Record<string, string> = {
  ethereum: 'eth',
  polygon: 'polygon',
  arbitrum: 'arbitrum',
  base: 'base',
  bsc: 'bsc',
  optimism: 'optimism',
  avalanche: 'avalanche'
};

export interface NovesToken {
  symbol: string;
  address: string;
  decimals: number;
  name?: string;
}

export interface NovesTransfer {
  action: string;
  amount: string;
  token: NovesToken;
}

export interface NovesClassification {
  type: string;
  description: string;
  sent: NovesTransfer[];
  received: NovesTransfer[];
}

export interface NovesTxResult {
  classificationData: NovesClassification;
  rawTransactionData: {
    transactionHash: string;
    timestamp: number;
  };
}

/** Exact-match type map (most common types). */
const NOVES_TYPE_EXACT: Record<string, TxType | null> = {
  swap: 'trade',
  tokenSwap: 'trade',
  dexSwap: 'trade',
  exchange: 'trade',
  jupiterSwap: 'trade',
  raydiumSwap: 'trade',
  orcaSwap: 'trade',
  claimRewards: 'income',
  collectRewards: 'income',
  claimStakingRewards: 'income',
  rewardsClaim: 'income',
  airdrop: 'income',
  nftMint: 'nft_mint',
  nftSale: 'nft_sell',
  nftPurchase: 'nft_buy',
  nftBuy: 'nft_buy',
  stakeDeposit: 'defi_deposit',
  stake: 'defi_deposit',
  staking: 'defi_deposit',
  stakeWithdrawal: 'defi_withdraw',
  unstake: 'defi_withdraw',
  unstaking: 'defi_withdraw',
  addLiquidity: 'defi_deposit',
  removeLiquidity: 'defi_withdraw',
  depositLiquidity: 'defi_deposit',
  withdrawLiquidity: 'defi_withdraw',
  lendingDeposit: 'defi_deposit',
  lendingWithdrawal: 'defi_withdraw',
  // Bridges move a user's own funds between chains. Default to transfer_out,
  // but `classifyNovesTx` reclassifies it to an internal transfer (non-taxable)
  // when both an out and an in leg exist, or a matching inbound is found on the
  // destination chain — see `isBridgeType` / `bridgeIsInternalTransfer`.
  bridge: 'transfer_out',
  // keep as-is
  transferERC20: null,
  transferNFT: null,
  transfer: null,
  approve: null,
  unknownTransaction: null
};

/**
 * Maps a Noves type string to a SoloLedger TxType.
 * First tries exact match, then falls back to substring/fuzzy matching.
 * This handles protocol-specific variants like "jupiterSwap", "raydiumSwap", etc.
 */
export function novesTxTypeToSoloLedger(novesType: string): TxType | null {
  if (novesType in NOVES_TYPE_EXACT) return NOVES_TYPE_EXACT[novesType];

  const lower = novesType.toLowerCase();
  // Fuzzy: swap/exchange/trade variants
  if (lower.includes('swap') || lower.includes('exchange') || lower.includes('trade')) return 'trade';
  // Fuzzy: staking
  if ((lower.includes('stake') || lower.includes('staking')) && !lower.includes('unstake')) return 'defi_deposit';
  if (lower.includes('unstake') || (lower.includes('stake') && lower.includes('withdrawal'))) return 'defi_withdraw';
  // Fuzzy: rewards / income
  if (lower.includes('claim') || lower.includes('reward') || lower.includes('airdrop')) return 'income';
  // Fuzzy: liquidity
  if (lower.includes('addliquidity') || lower.includes('deposit')) return 'defi_deposit';
  if (lower.includes('removeliquidity') || lower.includes('withdraw')) return 'defi_withdraw';
  // Fuzzy: NFT
  if (lower.includes('nftmint') || lower.includes('mint')) return 'nft_mint';
  if (lower.includes('nftsale') || lower.includes('sale')) return 'nft_sell';
  if (lower.includes('nftbuy') || lower.includes('nftpurchase')) return 'nft_buy';

  return null;
}

async function fetchNovesTx(
  apiKey: string,
  chain: string,
  txHash: string,
  walletAddress?: string
): Promise<NovesTxResult | null> {
  const novesChain = NOVES_EVM_CHAIN[chain];
  const isSolana = chain === 'solana';

  let url: string;
  if (isSolana) {
    url = `${NOVES_BASE}/solana/tx/${txHash}`;
  } else if (novesChain) {
    url = `${NOVES_BASE}/evm/${novesChain}/tx/${txHash}`;
  } else {
    return null; // unsupported chain
  }

  if (walletAddress) {
    url += `?viewAsAccountAddress=${walletAddress}`;
  }

  try {
    const proxyPath = isSaasMode()
      ? `/api/proxy/noves/${isSolana ? `solana/tx/${txHash}` : `evm/${novesChain}/tx/${txHash}`}${walletAddress ? `?viewAsAccountAddress=${walletAddress}` : ''}`
      : null;
    const res = proxyPath
      ? await saasProxyFetch(proxyPath)
      : await fetch(url, { headers: { apiKey } });
    if (res.status === 404) return null; // tx not found
    if (res.status === 429) throw new Error('Noves rate limit — slow down');
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.classificationData) return null;
    return data as NovesTxResult;
  } catch (err) {
    if (err instanceof Error && err.message.includes('rate limit')) throw err;
    return null;
  }
}

/** True when a Noves type string represents a cross-chain bridge. */
export function isBridgeType(novesType: string): boolean {
  return /bridge/i.test(novesType);
}

const BRIDGE_NON_FLOW_ACTIONS = new Set(['paidGas', 'paidFee', 'burned', 'approved']);

/**
 * A bridge is an internal transfer (moving a user's own funds between chains),
 * not a taxable disposal, when we can see both an outbound and an inbound leg.
 *
 * This covers two cases:
 *  1. Both legs are present in the same Noves classification (sent + received).
 *  2. A matching inbound was found separately on the destination chain — the
 *     caller passes `matchingInboundFound` (asset+amount+time-window match).
 */
export function bridgeIsInternalTransfer(
  sent: NovesTransfer[],
  received: NovesTransfer[],
  matchingInboundFound = false
): boolean {
  const realSent = sent.filter((s) => !BRIDGE_NON_FLOW_ACTIONS.has(s.action));
  const realReceived = received.filter((r) => !BRIDGE_NON_FLOW_ACTIONS.has(r.action));
  if (realSent.length > 0 && realReceived.length > 0) return true;
  return matchingInboundFound;
}

export interface NovesClassifyResult {
  /** Noves classified type string (e.g. "swap", "claimRewards") */
  novesType: string;
  /** Mapped SoloLedger type, or null if we should keep the existing type */
  soloLedgerType: TxType | null;
  description: string;
  sent: NovesTransfer[];
  received: NovesTransfer[];
  /** True for a bridge classified as a non-taxable internal transfer. */
  isInternalTransfer: boolean;
  /** Extra flag to attach (e.g. 'possible_internal_transfer' for bridges). */
  extraFlag?: 'possible_internal_transfer';
}

/**
 * Classify a single transaction hash via Noves. Returns null if chain unsupported or tx not found.
 *
 * `matchingInboundFound` lets the caller signal that a matching inbound leg was
 * located on the destination chain (asset + amount + time window), so a bridge
 * with only an out leg visible in this tx is still treated as an internal
 * transfer rather than a `transfer_out` disposal.
 */
export async function classifyNovesTx(
  apiKey: string,
  chain: string,
  txHash: string,
  walletAddress?: string,
  matchingInboundFound = false
): Promise<NovesClassifyResult | null> {
  const result = await fetchNovesTx(apiKey, chain, txHash, walletAddress);
  if (!result) return null;

  const { classificationData } = result;
  const novesType = classificationData.type ?? 'unknownTransaction';
  let soloLedgerType = novesTxTypeToSoloLedger(novesType);
  const sent = classificationData.sent ?? [];
  const received = classificationData.received ?? [];

  let isInternalTransfer = false;
  let extraFlag: 'possible_internal_transfer' | undefined;
  if (isBridgeType(novesType)) {
    if (bridgeIsInternalTransfer(sent, received, matchingInboundFound)) {
      // Bidirectional (or matched) bridge → non-taxable internal transfer.
      isInternalTransfer = true;
      soloLedgerType = received.length > 0 && sent.length === 0 ? 'transfer_in' : 'transfer_out';
      extraFlag = 'possible_internal_transfer';
    }
  }

  return {
    novesType,
    soloLedgerType,
    description: classificationData.description ?? '',
    sent,
    received,
    isInternalTransfer,
    extraFlag
  };
}

/**
 * Batch-classify many (chain, txHash, walletAddress) triples.
 * Respects rate limits with a 200ms delay between calls on Solana (10 CU each),
 * 300ms on EVM (25 CU each).
 */
export async function batchClassifyNoves(
  apiKey: string,
  items: { chain: string; txHash: string; walletAddress?: string }[],
  onProgress?: (done: number, total: number) => void
): Promise<(NovesClassifyResult | null)[]> {
  const results: (NovesClassifyResult | null)[] = [];
  for (let i = 0; i < items.length; i++) {
    const { chain, txHash, walletAddress } = items[i];
    // eslint-disable-next-line no-await-in-loop
    const r = await classifyNovesTx(apiKey, chain, txHash, walletAddress);
    results.push(r);
    onProgress?.(i + 1, items.length);
    if (i < items.length - 1) {
      const delay = chain === 'solana' ? 200 : 300;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  return results;
}
