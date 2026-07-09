/**
 * Helius Enhanced Transactions client for Solana.
 *
 * Primary data source for Solana wallets — returns pre-parsed, labelled
 * transactions including Jupiter DCA fills, staking, NFT activity, etc.
 *
 * Endpoint: GET https://mainnet.helius-rpc.com/v0/addresses/{address}/transactions
 * Docs: https://docs.helius.dev/enhanced-transactions/transaction-history
 *
 * Important: `token-accounts=balanceChanged` is required to include SPL token
 * receipts (e.g. DBT rewards) that land in associated token accounts, not only
 * txs that reference the wallet pubkey directly.
 */

import { makeId } from '@/lib/parsers/types';
import { resolveSolanaMintSymbol } from '@/lib/assets/solanaMints';
import { classifyDbtIncome, isDbtToken } from '@/lib/assets/dabbaRegistry';
import { classifyFromHelius } from '@/lib/rpc/classificationEngine';
import type { Transaction, FlagReason, TxType } from '@/types/transaction';
import { isSaasMode, getApiBase } from '@/lib/saas/config';
import { saasProxyFetch } from '@/lib/saas/api';

const HELIUS_BASE = 'https://mainnet.helius-rpc.com';

export interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount?: string;
  toTokenAccount?: string;
  tokenAmount: number;
  decimals?: number;
  mint: string;
  tokenStandard?: string;
}

export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number; // lamports
}

export interface HeliusSwapEvent {
  nativeInput?: { account: string; amount: number };
  nativeOutput?: { account: string; amount: number };
  tokenInputs?: Array<{ userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }>;
  tokenOutputs?: Array<{ userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }>;
}

export interface HeliusTransaction {
  signature: string;
  slot: number;
  timestamp: number;
  type: string;        // SWAP, TRANSFER, NFT_SALE, STAKE_SOL, etc.
  source: string;      // JUPITER, RAYDIUM, ORCA, SYSTEM_PROGRAM, etc.
  description: string;
  fee: number;
  feePayer: string;
  tokenTransfers: HeliusTokenTransfer[];
  nativeTransfers: HeliusNativeTransfer[];
  accountData: Array<{ account: string; nativeBalanceChange: number; tokenBalanceChanges: any[] }>;
  events?: {
    swap?: HeliusSwapEvent;
    nft?: any;
  };
}

function resolveSymbol(mint: string): string {
  const known = resolveSolanaMintSymbol(mint);
  if (known) return known;
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function rawAmountToDecimal(rawAmount: string, decimals: number): number {
  return Number(BigInt(rawAmount)) / 10 ** decimals;
}

/**
 * Convert a Helius SWAP transaction into a SoloLedger `trade` row.
 * Uses events.swap for exact amounts; falls back to tokenTransfers.
 */
function heliusSwapToTrade(
  htx: HeliusTransaction,
  walletAddress: string
): Transaction | null {
  const swap = htx.events?.swap;

  let inputMint: string | undefined;
  let inputAmount: number | undefined;
  let outputMint: string | undefined;
  let outputAmount: number | undefined;

  if (swap) {
    const inp = swap.tokenInputs?.[0];
    const out = swap.tokenOutputs?.[0];
    if (inp) {
      inputMint = inp.mint;
      inputAmount = rawAmountToDecimal(inp.rawTokenAmount.tokenAmount, inp.rawTokenAmount.decimals);
    }
    if (out) {
      outputMint = out.mint;
      outputAmount = rawAmountToDecimal(out.rawTokenAmount.tokenAmount, out.rawTokenAmount.decimals);
    }
    if (!inputMint && swap.nativeInput) {
      inputMint = 'So11111111111111111111111111111111111111112';
      inputAmount = swap.nativeInput.amount / 1e9;
    }
    if (!outputMint && swap.nativeOutput) {
      outputMint = 'So11111111111111111111111111111111111111112';
      outputAmount = swap.nativeOutput.amount / 1e9;
    }
  }

  if (!inputMint || !outputMint) {
    const sent = htx.tokenTransfers.filter((t) => t.fromUserAccount === walletAddress);
    const received = htx.tokenTransfers.filter((t) => t.toUserAccount === walletAddress);
    if (sent.length > 0 && !inputMint) {
      inputMint = sent[0].mint;
      inputAmount = sent.reduce((s, t) => s + t.tokenAmount, 0);
    }
    if (received.length > 0 && !outputMint) {
      outputMint = received[0].mint;
      outputAmount = received.reduce((s, t) => s + t.tokenAmount, 0);
    }
  }

  if (!inputMint || !outputMint) return null;

  const inputSymbol = resolveSymbol(inputMint);
  const outputSymbol = resolveSymbol(outputMint);

  return {
    id: makeId('rpc'),
    timestamp: htx.timestamp * 1000,
    type: 'trade',
    asset: inputSymbol,
    amount: inputAmount ?? 0,
    counterAsset: outputSymbol,
    counterAmount: outputAmount,
    contractAddress: inputMint,
    fiatCurrency: 'USD',
    fiatValue: undefined,
    source: `rpc:helius`,
    sourceRef: htx.signature,
    walletAddress,
    chain: 'solana',
    notes: htx.description || `Swapped ${inputSymbol} for ${outputSymbol} on ${htx.source}`,
    flags: ['missing_cost_basis'] as FlagReason[],
    isInternalTransfer: false
  };
}

/**
 * Convert a Helius TRANSFER (or other simple) transaction into
 * one or more SoloLedger rows.
 */
function heliusTransferToRows(
  htx: HeliusTransaction,
  walletAddress: string
): Transaction[] {
  const rows: Transaction[] = [];
  const ts = htx.timestamp * 1000;
  const processedMints = new Set<string>();

  const tokensSent = htx.tokenTransfers.filter((t) => t.fromUserAccount === walletAddress);
  const tokensReceived = htx.tokenTransfers.filter((t) => t.toUserAccount === walletAddress);

  for (const t of tokensSent) {
    processedMints.add(t.mint);
    const asset = resolveSymbol(t.mint);
    rows.push({
      id: makeId('rpc'),
      timestamp: ts,
      type: 'transfer_out',
      asset,
      amount: t.tokenAmount,
      contractAddress: t.mint,
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:helius',
      sourceRef: htx.signature,
      walletAddress,
      counterpartyAddress: t.toUserAccount,
      chain: 'solana',
      flags: ['possible_internal_transfer', 'missing_cost_basis'] as FlagReason[],
      isInternalTransfer: false
    });
  }

  for (const t of tokensReceived) {
    processedMints.add(t.mint);
    const asset = resolveSymbol(t.mint);
    const dbtIncome = isDbtToken(t.mint) && t.fromUserAccount !== walletAddress
      ? classifyDbtIncome(t.mint, t.fromUserAccount) ?? {
          kind: 'genesis_reward' as const,
          label: 'Dabba Network DBT reward',
          notes: 'Auto-classified as DBT income'
        }
      : null;

    rows.push({
      id: makeId('rpc'),
      timestamp: ts,
      type: dbtIncome ? 'income' : 'transfer_in',
      asset,
      amount: t.tokenAmount,
      contractAddress: t.mint,
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:helius',
      sourceRef: htx.signature,
      walletAddress,
      counterpartyAddress: t.fromUserAccount,
      chain: 'solana',
      category: dbtIncome?.kind,
      notes: dbtIncome?.notes,
      flags: dbtIncome ? [] : ['possible_internal_transfer', 'missing_cost_basis'] as FlagReason[],
      isInternalTransfer: false
    });
  }

  // SPL claims (e.g. DBT rewards) sometimes appear only in accountData.tokenBalanceChanges
  // when tokenTransfers is incomplete — requires token-accounts=balanceChanged on the API.
  for (const acct of htx.accountData ?? []) {
    for (const ch of acct.tokenBalanceChanges ?? []) {
      const mint: string | undefined = ch.mint ?? ch.tokenMint;
      const userAcct: string | undefined = ch.userAccount ?? ch.owner;
      if (!mint || processedMints.has(mint)) continue;
      if (userAcct && userAcct !== walletAddress) continue;

      const raw = ch.rawTokenAmount ?? ch.tokenAmount;
      const decimals = raw?.decimals ?? ch.decimals ?? 0;
      const tokenAmount =
        typeof ch.tokenAmount === 'number'
          ? ch.tokenAmount
          : raw?.tokenAmount != null
            ? Number(BigInt(String(raw.tokenAmount))) / 10 ** decimals
            : 0;
      if (tokenAmount <= 0) continue;

      processedMints.add(mint);
      const asset = resolveSymbol(mint);
      const dbtIncome = isDbtToken(mint)
        ? classifyDbtIncome(mint, acct.account) ?? {
            kind: 'genesis_reward' as const,
            label: 'Dabba Network DBT reward',
            notes: 'Auto-classified as DBT income (account balance change)'
          }
        : null;

      rows.push({
        id: makeId('rpc'),
        timestamp: ts,
        type: dbtIncome ? 'income' : 'transfer_in',
        asset,
        amount: tokenAmount,
        contractAddress: mint,
        fiatCurrency: 'USD',
        fiatValue: undefined,
        source: 'rpc:helius',
        sourceRef: htx.signature,
        walletAddress,
        counterpartyAddress: acct.account !== walletAddress ? acct.account : undefined,
        chain: 'solana',
        category: dbtIncome?.kind,
        notes: dbtIncome?.notes,
        flags: dbtIncome ? [] : ['possible_internal_transfer', 'missing_cost_basis'] as FlagReason[],
        isInternalTransfer: false
      });
    }
  }

  const solSent = htx.nativeTransfers.filter((t) => t.fromUserAccount === walletAddress);
  const solReceived = htx.nativeTransfers.filter((t) => t.toUserAccount === walletAddress);

  for (const t of solSent) {
    const sol = t.amount / 1e9;
    if (Math.abs(sol) < 0.000001) continue;
    rows.push({
      id: makeId('rpc'),
      timestamp: ts,
      type: 'transfer_out',
      asset: 'SOL',
      amount: sol,
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:helius',
      sourceRef: htx.signature,
      walletAddress,
      counterpartyAddress: t.toUserAccount,
      chain: 'solana',
      flags: ['possible_internal_transfer', 'missing_cost_basis'] as FlagReason[],
      isInternalTransfer: false
    });
  }

  for (const t of solReceived) {
    const sol = t.amount / 1e9;
    if (Math.abs(sol) < 0.000001) continue;
    rows.push({
      id: makeId('rpc'),
      timestamp: ts,
      type: 'transfer_in',
      asset: 'SOL',
      amount: sol,
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:helius',
      sourceRef: htx.signature,
      walletAddress,
      counterpartyAddress: t.fromUserAccount,
      chain: 'solana',
      flags: ['possible_internal_transfer', 'missing_cost_basis'] as FlagReason[],
      isInternalTransfer: false
    });
  }

  return rows;
}

/**
 * Convert one Helius transaction into SoloLedger transaction rows.
 */
function heliusTxToRows(htx: HeliusTransaction, walletAddress: string): Transaction[] {
  const classified = classifyFromHelius(htx.type, htx.source, htx.description);

  if (htx.type === 'SWAP' || classified?.type === 'trade') {
    const trade = heliusSwapToTrade(htx, walletAddress);
    if (trade) return [trade];
  }

  const defiType = classified?.type;
  if (defiType && ['defi_deposit', 'defi_withdraw', 'nft_mint', 'nft_sell', 'nft_buy'].includes(defiType)) {
    const rows = heliusTransferToRows(htx, walletAddress);
    return rows.map((r) => ({
      ...r,
      type: defiType as TxType,
      flags: ['missing_cost_basis'] as FlagReason[],
      notes: htx.description || classified?.notes
    }));
  }

  return heliusTransferToRows(htx, walletAddress);
}

export interface HeliusLookupResult {
  transactions: Transaction[];
  warnings: string[];
  /** Newest on-chain signature returned in this fetch (for incremental sync cursor). */
  newestSignature?: string;
}

/**
 * Fetch and parse Solana transaction history for one address via Helius.
 *
 * @param afterSignature  Incremental sync: only txs strictly after this signature
 *   (uses sort-order=asc + after-signature per Helius docs).
 */
export async function fetchHeliusSolana(
  address: string,
  apiKey: string,
  maxPages = 20,
  afterSignature?: string,
  /** On sync: skip any signatures already stored for this wallet. */
  skipSignatures?: Set<string>
): Promise<HeliusLookupResult> {
  const transactions: Transaction[] = [];
  const warnings: string[] = [];

  const isIncremental = !!afterSignature;
  let cursorSignature: string | undefined = afterSignature;
  let page = 0;
  let newestTimestamp = 0;
  let newestSignature: string | undefined;

  while (page < maxPages) {
    let url =
      isSaasMode()
        ? `${getApiBase()}/api/proxy/helius/v0/addresses/${address}/transactions?limit=100&token-accounts=balanceChanged&commitment=confirmed`
        : `${HELIUS_BASE}/v0/addresses/${address}/transactions?api-key=${apiKey}&limit=100&token-accounts=balanceChanged&commitment=confirmed`;

    if (isIncremental) {
      // Ascending: fetch txs strictly after the cursor signature
      url += `&sort-order=asc&after-signature=${cursorSignature}`;
    } else {
      // Full import: newest first, paginate backwards
      url += `&sort-order=desc`;
      if (cursorSignature) url += `&before-signature=${cursorSignature}`;
    }

    // eslint-disable-next-line no-await-in-loop
    const res = isSaasMode()
      ? await saasProxyFetch(url.replace(getApiBase(), ''))
      : await fetch(url);

    if (res.status === 401) {
      warnings.push('Helius: invalid API key — check Settings.');
      break;
    }
    if (res.status === 429) {
      warnings.push('Helius: rate limited — try again in a moment.');
      break;
    }
    if (!res.ok) {
      warnings.push(`Helius: returned ${res.status}`);
      break;
    }

    // eslint-disable-next-line no-await-in-loop
    const data: HeliusTransaction[] = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    for (const htx of data) {
      // Helius after-signature is inclusive — the cursor tx may be returned again
      if (skipSignatures?.has(htx.signature)) continue;
      if (isIncremental && afterSignature && htx.signature === afterSignature) continue;

      const rows = heliusTxToRows(htx, address);
      transactions.push(...rows);
      if (htx.timestamp >= newestTimestamp) {
        newestTimestamp = htx.timestamp;
        newestSignature = htx.signature;
      }
    }

    if (data.length < 100) break;

    const lastSig = data[data.length - 1].signature;
    cursorSignature = lastSig;
    page++;

    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 300));
  }

  return { transactions, warnings, newestSignature };
}
