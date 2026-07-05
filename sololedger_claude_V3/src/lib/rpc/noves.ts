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

/** Map Noves type strings → SoloLedger TxType. Unmapped types return null (keep existing). */
const NOVES_TO_TX_TYPE: Record<string, TxType | null> = {
  swap: 'trade',
  claimRewards: 'income',
  collectRewards: 'income',
  airdrop: 'income',
  nftMint: 'nft_mint',
  nftSale: 'nft_sell',
  nftPurchase: 'nft_buy',
  nftBuy: 'nft_buy',
  stakeDeposit: 'defi_deposit',
  stake: 'defi_deposit',
  stakeWithdrawal: 'defi_withdraw',
  unstake: 'defi_withdraw',
  addLiquidity: 'defi_deposit',
  removeLiquidity: 'defi_withdraw',
  lendingDeposit: 'defi_deposit',
  lendingWithdrawal: 'defi_withdraw',
  bridge: 'transfer_out',
  // transfers stay as-is
  transferERC20: null,
  transferNFT: null,
  transfer: null,
  approve: null,
  unknownTransaction: null
};

export function novesTxTypeToSoloLedger(novesType: string): TxType | null {
  return NOVES_TO_TX_TYPE[novesType] ?? null;
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
    const res = await fetch(url, { headers: { apiKey } });
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

export interface NovesClassifyResult {
  /** Noves classified type string (e.g. "swap", "claimRewards") */
  novesType: string;
  /** Mapped SoloLedger type, or null if we should keep the existing type */
  soloLedgerType: TxType | null;
  description: string;
  sent: NovesTransfer[];
  received: NovesTransfer[];
}

/** Classify a single transaction hash via Noves. Returns null if chain unsupported or tx not found. */
export async function classifyNovesTx(
  apiKey: string,
  chain: string,
  txHash: string,
  walletAddress?: string
): Promise<NovesClassifyResult | null> {
  const result = await fetchNovesTx(apiKey, chain, txHash, walletAddress);
  if (!result) return null;

  const { classificationData } = result;
  const novesType = classificationData.type ?? 'unknownTransaction';
  const soloLedgerType = novesTxTypeToSoloLedger(novesType);

  return {
    novesType,
    soloLedgerType,
    description: classificationData.description ?? '',
    sent: classificationData.sent ?? [],
    received: classificationData.received ?? []
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
