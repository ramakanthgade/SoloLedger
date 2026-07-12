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
import { transactionSourceKey } from '@/lib/storage/db';

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

function parseSignedTokenBalanceChange(ch: Record<string, unknown>): number | null {
  const raw = ch.rawTokenAmount as { tokenAmount?: string | number; decimals?: number } | undefined;
  if (raw?.tokenAmount != null) {
    const decimals = raw.decimals ?? (ch.decimals as number | undefined) ?? 0;
    return Number(BigInt(String(raw.tokenAmount))) / 10 ** decimals;
  }
  if (typeof ch.tokenAmount === 'number') return ch.tokenAmount;
  return null;
}

/** Owner-level net SPL delta per mint from Helius accountData (sums all ATAs). */
function ownerNetByMintFromAccountData(
  accountData: HeliusTransaction['accountData'],
  walletAddress: string
): { netByMint: Map<string, number>; mintsWithData: Set<string> } {
  const netByMint = new Map<string, number>();
  const mintsWithData = new Set<string>();

  const walletLower = walletAddress.toLowerCase();

  for (const acct of accountData ?? []) {
    for (const ch of acct.tokenBalanceChanges ?? []) {
      const mint: string | undefined = ch.mint ?? ch.tokenMint;
      const userAcct: string | undefined = ch.userAccount ?? ch.owner;
      if (!mint) continue;
      // Only count balance changes explicitly owned by this wallet (ignore orphan ATA rows).
      if (!userAcct || userAcct.toLowerCase() !== walletLower) continue;

      const signed = parseSignedTokenBalanceChange(ch);
      if (signed == null || Math.abs(signed) < 1e-12) continue;

      mintsWithData.add(mint);
      netByMint.set(mint, (netByMint.get(mint) ?? 0) + signed);
    }
  }

  return { netByMint, mintsWithData };
}

/** Net SPL delta per mint from Helius tokenTransfers (in − out for wallet owner). */
function ownerNetByMintFromTokenTransfers(
  transfers: HeliusTokenTransfer[],
  walletAddress: string
): Map<string, { net: number; counterparty?: string }> {
  const netByMint = new Map<string, { net: number; counterparty?: string }>();
  const seenLegs = new Set<string>();

  for (const t of transfers) {
    const legKey = [
      t.mint,
      t.fromTokenAccount ?? t.fromUserAccount,
      t.toTokenAccount ?? t.toUserAccount,
      t.tokenAmount
    ].join('|');
    if (seenLegs.has(legKey)) continue;
    seenLegs.add(legKey);

    if (t.fromUserAccount === walletAddress) {
      const prev = netByMint.get(t.mint) ?? { net: 0 };
      netByMint.set(t.mint, {
        net: prev.net - t.tokenAmount,
        counterparty: t.toUserAccount
      });
    }
    if (t.toUserAccount === walletAddress) {
      const prev = netByMint.get(t.mint) ?? { net: 0 };
      netByMint.set(t.mint, {
        net: prev.net + t.tokenAmount,
        counterparty: t.fromUserAccount
      });
    }
  }

  return netByMint;
}

function pushSplBalanceRow(
  rows: Transaction[],
  opts: {
    htx: HeliusTransaction;
    walletAddress: string;
    mint: string;
    net: number;
    counterparty?: string;
    fromAccountData: boolean;
  }
): void {
  const { htx, walletAddress, mint, net, counterparty, fromAccountData } = opts;
  if (Math.abs(net) < 1e-9) return;

  const asset = resolveSymbol(mint);
  const sourceKey = transactionSourceKey({
    sourceRef: htx.signature,
    walletAddress,
    asset,
    contractAddress: mint
  });
  if (sourceKey && rows.some((r) => transactionSourceKey(r) === sourceKey)) return;

  const inbound = net > 0;
  const amount = Math.abs(net);
  const dbtIncome =
    inbound && isDbtToken(mint) && counterparty !== walletAddress
      ? classifyDbtIncome(mint, counterparty) ?? {
          kind: 'genesis_reward' as const,
          label: 'Dabba Network DBT reward',
          notes: fromAccountData
            ? 'Auto-classified as DBT income (account balance change)'
            : 'Auto-classified as DBT income'
        }
      : null;

  rows.push({
    id: makeId('rpc'),
    timestamp: htx.timestamp * 1000,
    type: dbtIncome ? 'income' : inbound ? 'transfer_in' : 'transfer_out',
    asset,
    amount,
    contractAddress: mint,
    fiatCurrency: 'USD',
    fiatValue: undefined,
    source: 'rpc:helius',
    sourceRef: htx.signature,
    walletAddress,
    counterpartyAddress: counterparty,
    chain: 'solana',
    category: dbtIncome?.kind,
    notes: dbtIncome?.notes,
    flags: dbtIncome ? [] : (['possible_internal_transfer', 'missing_cost_basis'] as FlagReason[]),
    isInternalTransfer: false
  });
}

function rawAmountToDecimal(rawAmount: string, decimals: number): number {
  return Number(BigInt(rawAmount)) / 10 ** decimals;
}

/** Net native SOL change for the wallet owner (lamports → SOL). Prefers accountData. */
function walletNativeSolDelta(
  htx: HeliusTransaction,
  walletAddress: string
): { delta: number; counterpartyOut?: string; counterpartyIn?: string } {
  const walletLower = walletAddress.toLowerCase();
  for (const acct of htx.accountData ?? []) {
    if (acct.account?.toLowerCase() === walletLower && acct.nativeBalanceChange != null) {
      return { delta: acct.nativeBalanceChange / 1e9 };
    }
  }

  let solNet = 0;
  let solCounterpartyOut: string | undefined;
  let solCounterpartyIn: string | undefined;
  for (const t of htx.nativeTransfers) {
    const sol = t.amount / 1e9;
    if (t.fromUserAccount === walletAddress) {
      solNet -= sol;
      solCounterpartyOut = t.toUserAccount;
    }
    if (t.toUserAccount === walletAddress) {
      solNet += sol;
      solCounterpartyIn = t.fromUserAccount;
    }
  }
  return { delta: solNet, counterpartyOut: solCounterpartyOut, counterpartyIn: solCounterpartyIn };
}

/** Network fee paid by wallet — emitted on SWAP-only rows where SOL delta is not parsed separately. */
function pushSolanaNetworkFeeRow(
  rows: Transaction[],
  htx: HeliusTransaction,
  walletAddress: string
): void {
  if (htx.feePayer?.toLowerCase() !== walletAddress.toLowerCase()) return;
  const feeSol = (htx.fee ?? 0) / 1e9;
  if (feeSol < 1e-9) return;
  if (rows.some((r) => r.type === 'fee' && r.asset === 'SOL' && r.sourceRef === htx.signature)) return;

  rows.push({
    id: makeId('rpc'),
    timestamp: htx.timestamp * 1000,
    type: 'fee',
    asset: 'SOL',
    amount: feeSol,
    fiatCurrency: 'USD',
    fiatValue: undefined,
    source: 'rpc:helius',
    sourceRef: htx.signature,
    walletAddress,
    chain: 'solana',
    flags: ['missing_cost_basis'] as FlagReason[],
    isInternalTransfer: false,
    notes: 'Solana network fee'
  });
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
      inputAmount = Math.abs(rawAmountToDecimal(inp.rawTokenAmount.tokenAmount, inp.rawTokenAmount.decimals));
    }
    if (out) {
      outputMint = out.mint;
      outputAmount = Math.abs(rawAmountToDecimal(out.rawTokenAmount.tokenAmount, out.rawTokenAmount.decimals));
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

  const transferNet = ownerNetByMintFromTokenTransfers(htx.tokenTransfers, walletAddress);
  const { netByMint: accountDataNet } = ownerNetByMintFromAccountData(
    htx.accountData,
    walletAddress
  );

  const walletLower = walletAddress.toLowerCase();
  const walletHasSplAccountData = (htx.accountData ?? []).some((acct) =>
    (acct.tokenBalanceChanges ?? []).some((ch) => {
      const userAcct: string | undefined = ch.userAccount ?? ch.owner;
      return !!userAcct && userAcct.toLowerCase() === walletLower && !!(ch.mint ?? ch.tokenMint);
    })
  );

  if (walletHasSplAccountData) {
    for (const [mint, net] of accountDataNet) {
      pushSplBalanceRow(rows, {
        htx,
        walletAddress,
        mint,
        net,
        counterparty: transferNet.get(mint)?.counterparty,
        fromAccountData: true
      });
    }
  } else {
    for (const [mint, { net, counterparty }] of transferNet) {
      pushSplBalanceRow(rows, {
        htx,
        walletAddress,
        mint,
        net,
        counterparty,
        fromAccountData: false
      });
    }
  }

  // Net native SOL delta from accountData (includes fees + rent); fallback to nativeTransfers.
  const { delta: solNet, counterpartyOut: solCounterpartyOut, counterpartyIn: solCounterpartyIn } =
    walletNativeSolDelta(htx, walletAddress);

  if (Math.abs(solNet) >= 0.000001) {
    const inbound = solNet > 0;
    rows.push({
      id: makeId('rpc'),
      timestamp: htx.timestamp * 1000,
      type: inbound ? 'transfer_in' : 'transfer_out',
      asset: 'SOL',
      amount: Math.abs(solNet),
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:helius',
      sourceRef: htx.signature,
      walletAddress,
      counterpartyAddress: inbound ? solCounterpartyIn : solCounterpartyOut,
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
    if (trade) {
      const rows = [trade];
      pushSolanaNetworkFeeRow(rows, htx, walletAddress);
      return rows;
    }
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
