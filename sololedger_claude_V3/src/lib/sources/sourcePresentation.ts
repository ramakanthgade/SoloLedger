import type { AccountIdentityRow } from '@/lib/accounts/accountIdentity';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';
import type { CsvImportRow, ExchangeConnectionRow, LookupAddressRow } from '@/lib/storage/db';
import type { DeletedSourceEvidence, Transaction } from '@/types/transaction';
import { resolveWalletDisplayLabel } from '@/lib/accounts/walletDisplay';

export type SourceResolutionStatus = 'resolved' | 'deleted' | 'unresolved';

export interface SourcePresentation {
  accountKey: string;
  sourceKey: string;
  primaryLabel: string;
  subtitle: string;
  filterLabel: string;
  iconId: string | null;
  chain: string | null;
  address: string | null;
  status: SourceResolutionStatus;
  account: AccountIdentityRow | null;
  sourceKind: 'wallet' | 'exchange' | 'csv' | 'manual' | 'unknown';
  linkedDeletedSourceEvidence: DeletedSourceEvidence | null;
}

export interface SourcePresentationIndexes {
  accountsById: ReadonlyMap<string, AccountIdentityRow>;
  walletsByIdentity: ReadonlyMap<string, LookupAddressRow>;
  exchangesById: ReadonlyMap<string, ExchangeConnectionRow>;
  csvImportsById: ReadonlyMap<string, CsvImportRow>;
}

export interface SourcePresentationRows {
  accounts: readonly AccountIdentityRow[];
  wallets: readonly LookupAddressRow[];
  exchanges: readonly ExchangeConnectionRow[];
  csvImports: readonly CsvImportRow[];
}

const EXACT_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  binance: 'Binance', coinbase: 'Coinbase', kraken: 'Kraken', okx: 'OKX', kucoin: 'KuCoin',
  bitfinex: 'Bitfinex', bybit: 'Bybit', coindcx: 'CoinDCX', coinswitch: 'CoinSwitch',
  cryptocom: 'Crypto.com', gateio: 'Gate.io', gemini: 'Gemini', htx: 'HTX', btcmarkets: 'BTC Markets', bitvavo: 'Bitvavo', bitget: 'Bitget',
  hyperliquid: 'Hyperliquid', mudrex: 'Mudrex', wazirx: 'WazirX', zebpay: 'ZebPay',
  metamask: 'MetaMask', trustwallet: 'Trust Wallet', ledger: 'Ledger', phantom: 'Phantom', trezor: 'Trezor'
};

function humanizeExactId(value: string): string {
  const normalized = value.trim().toLowerCase();
  return EXACT_PROVIDER_LABELS[normalized] ?? value.trim().replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function firstNonBlank(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}

export function shortSourceIdentity(value: string): string {
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function accountFor(indexes: SourcePresentationIndexes, id?: string): AccountIdentityRow | null {
  return id ? indexes.accountsById.get(id) ?? null : null;
}

function parserIconId(parserId: string | null | undefined): string | null {
  if (!parserId) return null;
  const exact = parserId.trim().toLowerCase();
  return EXACT_PROVIDER_LABELS[exact] ? exact : null;
}

function normalizedSource(value: string): string {
  return value.trim().toLowerCase();
}

function matchesExchangeSource(transaction: Transaction, exchange: ExchangeConnectionRow): boolean {
  return normalizedSource(transaction.source) === `${normalizedSource(exchange.exchange)}_api`;
}

function matchesCsvSource(transaction: Transaction, csv: CsvImportRow): boolean {
  const source = normalizedSource(transaction.source);
  const parsers = (csv.parserId ?? '')
    .split('+')
    .map(normalizedSource)
    .filter(Boolean);
  return source === 'manual_mapping' || source === 'import' || parsers.includes(source);
}

function isWalletImportSource(transaction: Transaction): boolean {
  return normalizedSource(transaction.source).startsWith('rpc:');
}

export function buildSourcePresentationIndexes(rows: SourcePresentationRows): SourcePresentationIndexes {
  return {
    accountsById: new Map(rows.accounts.map((row) => [row.id, row])),
    walletsByIdentity: new Map(rows.wallets.map((row) => [canonicalWalletIdentity(row.chain, row.address), row])),
    exchangesById: new Map(rows.exchanges.map((row) => [row.id, row])),
    csvImportsById: new Map(rows.csvImports.map((row) => [row.id, row]))
  };
}

function unresolved(transaction: Transaction, label = 'Unresolved source'): SourcePresentation {
  const deleted = transaction.deletedSourceEvidence;
  const sourceKey = deleted
    ? `deleted-source:${deleted.sourceIdentityId}`
    : `unresolved-source:${transaction.id}`;
  return {
    accountKey: `unresolved-account:${sourceKey}`,
    sourceKey,
    primaryLabel: deleted ? 'Deleted source' : label,
    subtitle: deleted ? `${humanizeExactId(transaction.source)} · source removed` : humanizeExactId(transaction.source || 'unknown'),
    filterLabel: `${deleted ? 'Deleted source' : label} · ${shortSourceIdentity(deleted?.sourceIdentityId ?? transaction.id)}`,
    iconId: null,
    chain: transaction.chain ?? null,
    address: transaction.walletAddress ?? null,
    status: deleted ? 'deleted' : 'unresolved',
    account: null,
    sourceKind: deleted ? 'exchange' : 'unknown',
    linkedDeletedSourceEvidence: null
  };
}

/**
 * Resolve presentation only from durable B1 account identities and the exact
 * source row referenced by the transaction. It deliberately never chooses a
 * same-brand exchange connection, similarly labelled wallet, or parser peer.
 */
export function sourcePresentationForTransaction(
  transaction: Transaction,
  indexes: SourcePresentationIndexes,
  chainLabel?: string | null
): SourcePresentation {
  if (transaction.importBatchId) {
    const exchange = indexes.exchangesById.get(transaction.importBatchId);
    const csv = indexes.csvImportsById.get(transaction.importBatchId);
    const exactExchange = exchange && matchesExchangeSource(transaction, exchange) ? exchange : undefined;
    const exactCsv = csv && matchesCsvSource(transaction, csv) ? csv : undefined;

    // An overloaded import id is usable only when transaction provenance selects
    // exactly one source row. Never let lookup order choose between API and CSV.
    if (exactExchange && !exactCsv) {
      const account = accountFor(indexes, exactExchange.accountIdentityId);
      const provider = humanizeExactId(exactExchange.exchange);
      const primaryLabel = account?.label ?? exactExchange.label ?? provider;
      const sourceKey = `exchange-source:${exactExchange.id}`;
      return {
        accountKey: account?.canonicalKey ?? `unresolved-account:${sourceKey}`,
        sourceKey,
        primaryLabel,
        subtitle: `${provider} · API connection`,
        filterLabel: `${primaryLabel} · ${provider} · ${shortSourceIdentity(exactExchange.id)}`,
        iconId: exactExchange.exchange.toLowerCase(),
        chain: transaction.chain ?? null,
        address: null,
        status: account ? 'resolved' : 'unresolved',
        account,
        sourceKind: 'exchange',
        linkedDeletedSourceEvidence: transaction.deletedSourceEvidence ?? null
      };
    }
    if (exactCsv && !exactExchange) {
      const account = accountFor(indexes, exactCsv.accountIdentityId);
      const parser = exactCsv.parserId ? humanizeExactId(exactCsv.parserId) : 'Unknown parser';
      const primaryLabel = account?.label ?? (exactCsv.parserId ? `${parser} account` : 'CSV account');
      const sourceKey = `csv-source:${exactCsv.id}`;
      return {
        accountKey: account?.canonicalKey ?? `unresolved-account:${sourceKey}`,
        sourceKey,
        primaryLabel,
        subtitle: `${parser} · ${exactCsv.fileName}`,
        filterLabel: `${primaryLabel} · ${parser} · ${exactCsv.fileName} · ${shortSourceIdentity(exactCsv.id)}`,
        iconId: parserIconId(exactCsv.parserId),
        chain: transaction.chain ?? null,
        address: null,
        status: account ? 'resolved' : 'unresolved',
        account,
        sourceKind: 'csv',
        linkedDeletedSourceEvidence: transaction.deletedSourceEvidence ?? null
      };
    }
    return unresolved(transaction);
  }

  if (transaction.walletAddress && transaction.chain && isWalletImportSource(transaction)) {
    const source = indexes.walletsByIdentity.get(canonicalWalletIdentity(transaction.chain, transaction.walletAddress));
    if (!source) return unresolved(transaction);
    const account = accountFor(indexes, source.accountIdentityId);
    const appId = account?.walletAppId ?? source.walletAppId ?? null;
    const primaryLabel = resolveWalletDisplayLabel({
      label: firstNonBlank(account?.label, source.label), walletAppId: appId, address: source.address
    });
    const chain = chainLabel ?? humanizeExactId(source.chain);
    const address = shortSourceIdentity(source.address);
    const sourceKey = `wallet-source:${source.id}:${source.sourceIncarnation ?? 'legacy'}`;
    return {
      accountKey: account?.canonicalKey ?? `unresolved-account:${sourceKey}`,
      sourceKey,
      primaryLabel,
      subtitle: `${chain} · ${address}`,
      filterLabel: `${primaryLabel} · ${chain} · ${address}`,
      iconId: appId,
      chain: source.chain,
      address: source.address,
      status: account ? 'resolved' : 'unresolved',
      account,
      sourceKind: 'wallet',
      linkedDeletedSourceEvidence: transaction.deletedSourceEvidence ?? null
    };
  }

  if (transaction.source === 'manual' || transaction.source === 'manual_mapping') {
    const sourceKey = `manual-source:${transaction.source}`;
    return {
      accountKey: sourceKey,
      sourceKey,
      primaryLabel: 'Manual entry',
      subtitle: 'Entered on this device',
      filterLabel: 'Manual entry · This device',
      iconId: null,
      chain: transaction.chain ?? null,
      address: null,
      status: 'resolved',
      account: null,
      sourceKind: 'manual',
      linkedDeletedSourceEvidence: transaction.deletedSourceEvidence ?? null
    };
  }

  return unresolved(transaction);
}

export function buildTransactionSourcePresentations(
  transactions: readonly Transaction[],
  indexes: SourcePresentationIndexes,
  chainLabel: (chain: string) => string = humanizeExactId
): ReadonlyMap<string, SourcePresentation> {
  return new Map(transactions.map((transaction) => [
    transaction.id,
    sourcePresentationForTransaction(transaction, indexes, transaction.chain ? chainLabel(transaction.chain) : null)
  ]));
}
