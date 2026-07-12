/**
 * Decide when Portfolio can compare ledger math to live on-chain balances.
 *
 * Live RPC cross-check only applies when the ledger is entirely (or per-wallet)
 * sourced from wallet imports. CSV, manual, and exchange rows cannot be validated
 * against a single wallet's chain state.
 */
import type { Transaction } from '@/types/transaction';
import type { LookupAddressRow } from '@/lib/storage/db';
import { SOL_MAIN_WALLET_TOLERANCE } from '@/lib/portfolio/solBalance';

export const ALL_WALLETS = 'All wallets';

export type PortfolioCrossCheckMode =
  /** One lookup wallet, rpc-only ledger → compare portfolio totals to chain. */
  | 'single_wallet_live'
  /** Multiple lookup wallets, rpc-only → compare each wallet separately. */
  | 'per_wallet_live'
  /** Wallet filter active and that wallet is rpc-only → compare scoped totals. */
  | 'scoped_wallet_live'
  /** CSV / manual / exchange / mixed sources → ledger integrity checks only. */
  | 'ledger_integrity_only';

export interface PortfolioSourceSummary {
  lookupWalletCount: number;
  solanaLookupCount: number;
  rpcTxCount: number;
  nonRpcTxCount: number;
  manualTxCount: number;
  csvExchangeTxCount: number;
  /** Distinct non-rpc source labels, e.g. coinbase, binance, manual */
  nonRpcSources: string[];
}

export interface BalanceVariance {
  wallet?: string;
  asset: string;
  contractAddress?: string;
  chain?: string;
  ledger: number;
  live: number;
  delta: number;
  pct: number;
}

export interface LedgerIntegrityIssue {
  kind: 'negative_holding' | 'mixed_sources';
  message: string;
  asset?: string;
}

export function isRpcSourced(source: string): boolean {
  return source.startsWith('rpc:');
}

function sourceLabel(source: string): string {
  if (source.startsWith('rpc:')) return source.slice(4);
  return source;
}

export function summarizePortfolioSources(
  transactions: Transaction[],
  lookupAddresses: LookupAddressRow[]
): PortfolioSourceSummary {
  const txs = transactions.filter((t) => !t.isSpam);
  let rpcTxCount = 0;
  let manualTxCount = 0;
  let csvExchangeTxCount = 0;
  const nonRpcSourceSet = new Set<string>();

  for (const t of txs) {
    if (isRpcSourced(t.source)) {
      rpcTxCount++;
      continue;
    }
    nonRpcSourceSet.add(sourceLabel(t.source));
    if (t.source === 'manual') manualTxCount++;
    if (
      t.source === 'coinbase' ||
      t.source.startsWith('binance') ||
      t.source === 'manual_mapping'
    ) {
      csvExchangeTxCount++;
    }
  }

  const solanaLookupCount = lookupAddresses.filter((w) => w.chain === 'solana').length;

  return {
    lookupWalletCount: lookupAddresses.length,
    solanaLookupCount,
    rpcTxCount,
    nonRpcTxCount: txs.length - rpcTxCount,
    manualTxCount,
    csvExchangeTxCount,
    nonRpcSources: Array.from(nonRpcSourceSet).sort()
  };
}

/** True when every tx tagged to this wallet is from an on-chain import. */
export function walletHasOnlyRpcTxs(transactions: Transaction[], walletAddress: string): boolean {
  const lower = walletAddress.toLowerCase();
  const walletTxs = transactions.filter(
    (t) => !t.isSpam && t.walletAddress?.toLowerCase() === lower
  );
  if (walletTxs.length === 0) return false;
  return walletTxs.every((t) => isRpcSourced(t.source));
}

/** Resolve cross-check mode with full transaction context. */
export function resolveCrossCheckMode(
  transactions: Transaction[],
  lookupAddresses: LookupAddressRow[],
  selectedWallet: string
): PortfolioCrossCheckMode {
  const summary = summarizePortfolioSources(transactions, lookupAddresses);
  const solanaWallets = lookupAddresses.filter((w) => w.chain === 'solana');

  if (selectedWallet !== ALL_WALLETS) {
    const inLookup = solanaWallets.some(
      (w) => w.address.toLowerCase() === selectedWallet.toLowerCase()
    );
    if (inLookup && walletHasOnlyRpcTxs(transactions, selectedWallet)) {
      return 'scoped_wallet_live';
    }
    return 'ledger_integrity_only';
  }

  if (summary.nonRpcTxCount > 0 || solanaWallets.length === 0) {
    return 'ledger_integrity_only';
  }
  if (solanaWallets.length === 1) return 'single_wallet_live';
  return 'per_wallet_live';
}

export function crossCheckModeUsesLiveRpc(mode: PortfolioCrossCheckMode): boolean {
  return mode !== 'ledger_integrity_only';
}

export function isSignificantBalanceVariance(
  asset: string,
  chain: string | undefined,
  delta: number,
  live: number
): boolean {
  if (asset === 'SOL' && chain === 'solana') {
    return Math.abs(delta) > SOL_MAIN_WALLET_TOLERANCE;
  }
  return Math.abs(delta) > Math.max(0.0001, Math.abs(live) * 0.001);
}

export function compareHoldingsToLive(
  holdings: Array<{ asset: string; contractAddress?: string; chain?: string; amount: number }>,
  liveByMint: Map<string, number>,
  holdingKey: (h: { contractAddress?: string; asset: string; chain?: string }) => string,
  wallet?: string
): BalanceVariance[] {
  const variances: BalanceVariance[] = [];
  for (const h of holdings) {
    const mintKey = holdingKey(h);
    const symKey = h.asset.toUpperCase();
    const live = liveByMint.get(mintKey) ?? liveByMint.get(symKey);
    if (live == null) continue;
    const delta = h.amount - live;
    if (!isSignificantBalanceVariance(h.asset, h.chain, delta, live)) continue;
    variances.push({
      wallet,
      asset: h.asset,
      contractAddress: h.contractAddress,
      chain: h.chain,
      ledger: h.amount,
      live,
      delta,
      pct: live > 0 ? (delta / live) * 100 : 0
    });
  }
  return variances;
}

export function checkLedgerIntegrity(
  holdings: Array<{ asset: string; amount: number }>,
  summary: PortfolioSourceSummary
): LedgerIntegrityIssue[] {
  const issues: LedgerIntegrityIssue[] = [];

  if (summary.nonRpcTxCount > 0) {
    const parts: string[] = [];
    if (summary.csvExchangeTxCount > 0) parts.push('exchange CSV');
    if (summary.manualTxCount > 0) parts.push('manual entries');
    const other = summary.nonRpcSources.filter(
      (s) => s !== 'manual' && !s.startsWith('binance') && s !== 'coinbase' && s !== 'manual_mapping'
    );
    if (other.length > 0) parts.push(other.join(', '));
    const detail = parts.length > 0 ? parts.join(' and ') : `${summary.nonRpcTxCount} non-wallet tx`;
    issues.push({
      kind: 'mixed_sources',
      message:
        `Portfolio includes ${detail} — combined totals cannot be checked against a single on-chain wallet. ` +
        (summary.lookupWalletCount > 0
          ? 'Select one imported wallet in the filter to validate that wallet against the chain, or export for review.'
          : 'Validate using exports or cost-basis reports.')
    });
  }

  for (const h of holdings) {
    if (h.amount < -1e-6) {
      issues.push({
        kind: 'negative_holding',
        asset: h.asset,
        message: `${h.asset} balance is negative (${h.amount.toFixed(8)}) — review transfers and trades in Review.`
      });
    }
  }

  return issues;
}

export function formatWalletShort(address: string): string {
  return address.length > 20 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}
