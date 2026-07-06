/**
 * Unified transaction classification engine.
 *
 * Priority order (highest confidence first):
 *   1. Helius type labels  (Solana — decoded smart contract interactions)
 *   2. Moralis category labels (EVM — decoded contract + spam detection)
 *   3. Noves Translate (EVM + Solana — 10,000+ protocol coverage)
 *   4. Dabba DBT registry (Solana — Dabba-specific income rules)
 *   5. DCA vault detection (local — recurring fill pattern)
 *   6. Local 1-in/1-out heuristic (last resort)
 */

import type { TxType, FlagReason } from '@/types/transaction';

// ─────────────────────────────────────────────────────────────────────────────
// Helius type mapping
// Docs: https://docs.helius.dev/enhanced-transactions/overview
// ─────────────────────────────────────────────────────────────────────────────

/** Helius transaction type → SoloLedger TxType. null = use direction from transfers. */
export const HELIUS_TYPE_MAP: Record<string, TxType | null> = {
  SWAP: 'trade',
  NFT_MINT: 'nft_mint',
  NFT_SALE: 'nft_sell',
  NFT_AUCTION_SALE: 'nft_sell',
  NFT_PURCHASE: 'nft_buy',
  NFT_AUCTION_BID: 'nft_buy',
  NFT_AUCTION_BID_CANCELLED: null,
  COMPRESSED_NFT_MINT: 'nft_mint',
  COMPRESSED_NFT_TRANSFER: null,
  COMPRESSED_NFT_BURN: 'fee',
  STAKE_SOL: 'defi_deposit',
  UNSTAKE_SOL: 'defi_withdraw',
  STAKE_TOKEN: 'defi_deposit',
  UNSTAKE_TOKEN: 'defi_withdraw',
  INIT_STAKE_ACCOUNT: 'defi_deposit',
  CREATE_POOL: 'defi_deposit',
  ADD_LIQUIDITY: 'defi_deposit',
  REMOVE_LIQUIDITY: 'defi_withdraw',
  LOAN: 'defi_deposit',
  REPAY_LOAN: 'defi_withdraw',
  WITHDRAW_LOAN: 'defi_withdraw',
  LIQUIDATE_LOAN: 'defi_withdraw',
  BURN: 'fee',
  BURN_NFT: 'fee',
  TRANSFER: null, // direction determined by tokenTransfers/nativeTransfers
  UNKNOWN: null
};

/** Helius "source" program → human label (for notes field). */
export const HELIUS_SOURCE_LABEL: Record<string, string> = {
  JUPITER: 'Jupiter',
  RAYDIUM: 'Raydium',
  ORCA: 'Orca',
  SERUM: 'Serum',
  MAGIC_EDEN: 'Magic Eden',
  TENSOR: 'Tensor',
  MARINADE: 'Marinade',
  LIDO: 'Lido',
  MANGO: 'Mango Markets',
  DRIFT: 'Drift Protocol',
  SYSTEM_PROGRAM: 'Solana'
};

// ─────────────────────────────────────────────────────────────────────────────
// Moralis category mapping
// Docs: https://docs.moralis.com/data-api/evm/wallet/wallet-history
// ─────────────────────────────────────────────────────────────────────────────

/** Moralis category string → SoloLedger TxType. null = determine from transfers. */
export const MORALIS_CATEGORY_MAP: Record<string, TxType | null> = {
  'token swap': 'trade',
  'nft sale': 'nft_sell',
  'nft purchase': 'nft_buy',
  'nft send': 'transfer_out',
  'nft receive': 'transfer_in',
  'token send': 'transfer_out',
  'token receive': 'transfer_in',
  'send': 'transfer_out',
  'receive': 'transfer_in',
  'airdrop': 'income',
  'mint': 'nft_mint',
  'burn': 'fee',
  'deposit': 'defi_deposit',
  'withdraw': 'defi_withdraw',
  'borrow': 'defi_deposit',
  'repay': 'defi_withdraw',
  'staking': 'defi_deposit',
  'unstaking': 'defi_withdraw',
  'contract interaction': null
};

// ─────────────────────────────────────────────────────────────────────────────
// Common helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Infer flags based on classified type. */
export function flagsForType(_type: TxType, classified: boolean): FlagReason[] {
  if (classified) return ['missing_cost_basis'];
  return ['possible_internal_transfer', 'missing_cost_basis'];
}

/** Format a human-readable note from Helius transaction. */
export function heliusNote(description: string, source: string): string {
  const sourceLabel = HELIUS_SOURCE_LABEL[source] ?? source;
  if (description && description.length < 200) return description;
  return sourceLabel ? `Transaction on ${sourceLabel}` : 'Helius parsed transaction';
}

/** Format a human-readable note from Moralis transaction. */
export function moralisNote(summary: string, category: string): string {
  if (summary && summary.length < 200) return summary;
  return category ?? 'Moralis parsed transaction';
}

export interface ClassifiedType {
  type: TxType;
  source: 'helius' | 'moralis' | 'noves' | 'dabba' | 'local';
  notes?: string;
  spam?: boolean;
}

/** Map Helius type string to SoloLedger type + metadata. */
export function classifyFromHelius(
  heliusType: string,
  source: string,
  description: string
): ClassifiedType | null {
  const type = HELIUS_TYPE_MAP[heliusType];
  if (type === undefined) {
    // Unknown Helius type — fuzzy match
    const lower = heliusType.toLowerCase();
    if (lower.includes('swap') || lower.includes('exchange')) return { type: 'trade', source: 'helius', notes: heliusNote(description, source) };
    if (lower.includes('stake')) return { type: 'defi_deposit', source: 'helius', notes: heliusNote(description, source) };
    if (lower.includes('unstake')) return { type: 'defi_withdraw', source: 'helius', notes: heliusNote(description, source) };
    if (lower.includes('nft')) return { type: 'transfer_in', source: 'helius', notes: heliusNote(description, source) };
    return null;
  }
  if (type === null) return null; // direction-based, handled in caller
  return { type, source: 'helius', notes: heliusNote(description, source) };
}

/** Map Moralis category to SoloLedger type + metadata. */
export function classifyFromMoralis(
  category: string,
  summary: string,
  possibleSpam: boolean
): ClassifiedType | null {
  if (possibleSpam) return { type: 'transfer_in', source: 'moralis', spam: true, notes: 'Moralis flagged as spam' };
  const mapped = MORALIS_CATEGORY_MAP[category.toLowerCase()];
  if (mapped === undefined || mapped === null) return null;
  return { type: mapped, source: 'moralis', notes: moralisNote(summary, category) };
}
