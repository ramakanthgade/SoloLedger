/**
 * Unified connection model for the Connections home (Connections v2).
 *
 * Merges the app's three real connection stores into one card list:
 * - exchange API connections (hosted auto-sync, lib/exchangeSync)
 * - file imports (csvImports rows from IndexedDB)
 * - watched wallet addresses (lookupAddresses rows, grouped per address)
 * - manual entry (transactions with source 'manual' — one summary card)
 *
 * Every field shown on a card derives from data that actually exists —
 * sync state is `lastError`/`lastSyncAt`/tx counts; there is no invented
 * health score. Classification into the filter pills is honest:
 * exchanges = API connections + exchange-export files; watched addresses
 * labeled after a wallet app (or watched on multiple chains) = Wallet apps;
 * other watched addresses = Blockchains; manual = Manual entry.
 */
import type { ExchangeConnectionView } from '@/lib/exchangeSync';
import type { CsvImportRow, LookupAddressRow } from '@/lib/storage/db';
import { getAutoSyncExchange } from '@/components/import/autoSyncExchanges';
import { getImportSource } from '@/components/import/importSources';
import { CHAINS } from '@/lib/rpc/providers';
import { brandLabel, chainIconId, parserIconId, WALLET_APP_NAMES } from './brandIcons';
import {
  walletConnectionGroupKey
} from '@/lib/ledger/chainNamespace';

export type PillFilter = 'all' | 'exchanges' | 'wallets' | 'chains' | 'manual';
export type CardLane = Exclude<PillFilter, 'all'>;

export interface CardStatus {
  tone: 'gain' | 'warn' | 'primary' | 'neutral';
  label: string;
}

export interface ConnectionCardData {
  /** Stable React key, unique per card. */
  id: string;
  kind: 'exchange-api' | 'file' | 'wallet' | 'manual';
  lane: CardLane;
  /** brandIcons registry key (null → aurora monogram fallback). */
  iconId: string | null;
  /** Monogram source for the fallback chip. */
  iconFallback: string;
  title: string;
  subtitle: string;
  tags: string[];
  status: CardStatus;
  /** Primary meta line, e.g. "Synced 2h ago". */
  metaLine: string;
  /** Secondary line, e.g. "1,284 transactions". */
  txLine?: string;
  /** Attention line shown under the meta block (exchange lastError). */
  error?: string | null;
  /** This source must be reauthorized before any sync action is reachable. */
  requiresReauthorization?: boolean;
  /**
   * Honest sync-completeness chip (live-feedback round, item 8), derived from
   * ACTUAL sync state only — never an invented health score. Wallets: chains
   * fully synced ÷ chains enabled ("2/3 chains · 67%"). Exchanges: which data
   * ranges a completed sync covers ("Trades ✓ · Deposits ✓ · Withdrawals —").
   * Undefined at 100% — the green Synced/Watching state already says it.
   */
  syncChip?: string;
  /** Payload references for card actions. */
  exchange?: ExchangeConnectionView;
  csvImport?: CsvImportRow;
  walletRows?: LookupAddressRow[];
}

/** Watched addresses grouped into ONE card per unique address. */
export interface WalletGroup {
  key: string;
  address: string;
  label?: string;
  rows: LookupAddressRow[];
  chains: string[];
  txCount: number;
  lastSyncedAt: number;
}

/** "0x7a3F…4Ef2" style truncation used across wallet cards and pickers. */
export function shortAddress(address: string): string {
  const a = address.trim();
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Truncate a long file name keep-start/keep-end style. */
export function shortFileName(name: string): string {
  return name.length > 40 ? `${name.slice(0, 28)}…${name.slice(-10)}` : name;
}

/** Plain relative time — "just now", "5m ago", "2h ago", "yesterday", "3d ago", else a date. */
export function relativeTime(ts: number | null | undefined, now: number = Date.now()): string {
  if (ts == null) return 'never';
  const diff = Math.max(0, now - ts);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Group EVM rows across chains; preserve exact non-EVM chain/address identities. */
export function groupWallets(rows: LookupAddressRow[]): WalletGroup[] {
  const byAddress = new Map<string, LookupAddressRow[]>();
  for (const row of rows) {
    const key = walletConnectionGroupKey(row.chain, row.address);
    const group = byAddress.get(key) ?? [];
    group.push(row);
    byAddress.set(key, group);
  }
  return Array.from(byAddress.entries()).map(([key, groupRows]) => {
    const chains = Array.from(new Set(groupRows.map((r) => r.chain)));
    const label = groupRows.map((r) => r.label?.trim()).find((l) => l);
    return {
      key,
      address: groupRows[0].address,
      label: label || undefined,
      rows: groupRows,
      chains,
      txCount: groupRows.reduce((sum, r) => sum + r.txCount, 0),
      lastSyncedAt: Math.max(...groupRows.map((r) => r.lastSyncedAt))
    };
  });
}

/**
 * Whole-word includes: "cake" matches "my cake wallet" but not
 * "pancakeswap" — substring matching misclassifies lanes once the catalog
 * names short tokens like Cake, Leap or Brave.
 */
export function containsWord(label: string, name: string): boolean {
  let i = label.indexOf(name);
  while (i !== -1) {
    const before = i === 0 ? '' : label[i - 1];
    const after = i + name.length >= label.length ? '' : label[i + name.length];
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    i = label.indexOf(name, i + 1);
  }
  return false;
}

/** Wallet-app heuristic: labeled after a known wallet app, or multi-chain. */
export function walletLane(group: WalletGroup): 'wallets' | 'chains' {
  const label = group.label?.toLowerCase() ?? '';
  if (label && WALLET_APP_NAMES.some((name) => containsWord(label, name))) return 'wallets';
  return group.chains.length > 1 ? 'wallets' : 'chains';
}

function chainLabel(chainId: string): string {
  return CHAINS.find((c) => c.id === chainId)?.label ?? chainId;
}

/** Exchange data ranges auto-sync covers, in display order (cursor kinds). */
const EXCHANGE_SYNC_KINDS = [
  { key: 'trades', label: 'Trades' },
  { key: 'deposits', label: 'Deposits' },
  { key: 'withdrawals', label: 'Withdrawals' }
] as const;

/**
 * Exchange sync-completeness chip: which data ranges a COMPLETED sync covers,
 * from the persisted per-kind cursors (written only after a successful save —
 * so ✓ means "covered through the last sync", never a guess). All three
 * covered → undefined (100% keeps the green Synced state); never synced →
 * undefined (the "Not synced yet" meta line already says it).
 */
export function exchangeCoverageChip(c: ExchangeConnectionView): string | undefined {
  if (c.lastSyncAt == null) return undefined;
  const covered = EXCHANGE_SYNC_KINDS.filter((k) => c.cursors?.[k.key] != null);
  if (covered.length === EXCHANGE_SYNC_KINDS.length) return undefined;
  return EXCHANGE_SYNC_KINDS.map((k) =>
    `${k.label} ${c.cursors?.[k.key] != null ? '✓' : '—'}`
  ).join(' · ');
}

/**
 * Wallet sync-completeness chip: chains fully synced ÷ chains enabled. A
 * chain counts as fully synced when its row has a completed-sync timestamp
 * (lastSyncedAt > 0 — stamped by every successful wallet import). All chains
 * synced → undefined (100% keeps the green Watching state).
 */
export function walletChainChip(group: WalletGroup): string | undefined {
  const total = group.chains.length;
  if (total === 0) return undefined;
  const synced = group.rows.filter((r) => r.lastSyncedAt > 0).length;
  if (synced === 0 || synced >= total) return undefined;
  const pct = Math.round((synced / total) * 100);
  return `${synced}/${total} chains · ${pct}%`;
}

/** Display title for a file import: the exchange it came from, else the file name. */
export function fileImportTitle(row: CsvImportRow): string {
  if (row.parserId === 'binance_options') return 'Binance Options';
  const exchangeId = fileImportExchangeId(row);
  if (exchangeId && parserIconId(row.parserId)) return brandLabel(exchangeId);
  const source = getImportSource(exchangeId);
  if (source) return source.label;
  return shortFileName(row.fileName);
}

/**
 * Normalize a persisted parser id to its exchange identity. File status must
 * come from csvImports + parser output only — never from a filename or an API
 * connection with the same brand.
 */
export function fileImportExchangeId(row: Pick<CsvImportRow, 'parserId'>): string | null {
  if (!row.parserId) return null;
  const slug = row.parserId.split('_')[0].toLowerCase();
  return getImportSource(slug)?.id ?? parserIconId(row.parserId) ?? null;
}

export interface BuildCardsInput {
  connections: ExchangeConnectionView[];
  csvImports: CsvImportRow[];
  wallets: LookupAddressRow[];
  manualCount: number;
  /** Exchange sync job state — drives per-card Syncing status. */
  syncingConnectionId: string | null;
  syncActive: boolean;
}

/** Merge every connection store into the unified, pill-filterable card list. */
export function buildCards(input: BuildCardsInput): ConnectionCardData[] {
  const cards: ConnectionCardData[] = [];

  for (const c of input.connections) {
    const meta = getAutoSyncExchange(c.exchange);
    const syncing = input.syncActive && input.syncingConnectionId === c.id;
    const requiresReauthorization = c.credentialsState === 'reauthorization_required';
    cards.push({
      id: `exchange:${c.id}`,
      kind: 'exchange-api',
      lane: 'exchanges',
      iconId: c.exchange,
      iconFallback: meta?.monogram ?? c.exchange,
      title: c.label?.trim() ? `${meta?.label ?? c.exchange} · ${c.label.trim()}` : (meta?.label ?? c.exchange),
      subtitle: 'API auto-sync',
      tags: ['Exchange', 'API auto-sync'],
      status: requiresReauthorization
        ? { tone: 'warn', label: 'Reauthorization required' }
        : syncing
        ? { tone: 'primary', label: 'Syncing' }
        : c.lastError != null
          ? { tone: 'warn', label: 'Needs attention' }
          : { tone: 'gain', label: 'Synced' },
      metaLine: requiresReauthorization
        ? 'Sync paused'
        : c.lastSyncAt != null
          ? `Synced ${relativeTime(c.lastSyncAt)}`
          : 'Not synced yet',
      txLine: `${c.txCount.toLocaleString()} transaction${c.txCount === 1 ? '' : 's'}`,
      error: requiresReauthorization
        ? `Reconnect ${meta?.label ?? c.exchange} with a new read-only API key to resume syncing.`
        : c.lastError,
      requiresReauthorization,
      syncChip: requiresReauthorization ? undefined : exchangeCoverageChip(c),
      exchange: c
    });
  }

  for (const row of input.csvImports) {
    const title = fileImportTitle(row);
    cards.push({
      id: `file:${row.id}`,
      kind: 'file',
      lane: 'exchanges',
      iconId: parserIconId(row.parserId) ?? null,
      iconFallback: title,
      title,
      subtitle: shortFileName(row.fileName),
      tags: ['Exchange', 'File'],
      status: { tone: 'primary', label: 'CSV imported' },
      metaLine: `Imported ${new Date(row.importedAt).toLocaleDateString()}`,
      txLine: `${row.txCount.toLocaleString()} transaction${row.txCount === 1 ? '' : 's'}`,
      csvImport: row
    });
  }

  for (const group of groupWallets(input.wallets)) {
    const lane = walletLane(group);
    const primaryChain = group.chains[0];
    cards.push({
      id: `wallet:${group.key}`,
      kind: 'wallet',
      lane,
      iconId: chainIconId(primaryChain) ?? null,
      iconFallback: group.label ?? chainLabel(primaryChain),
      title: group.label ?? shortAddress(group.address),
      subtitle: group.label
        ? `${shortAddress(group.address)} · ${chainLabel(primaryChain)}`
        : chainLabel(primaryChain),
      tags: [
        lane === 'wallets' ? 'Wallet app' : 'Blockchain',
        group.chains.length > 1 ? `${group.chains.length} chains` : 'Address'
      ],
      status: { tone: 'gain', label: 'Watching' },
      metaLine:
        group.lastSyncedAt > 0 ? `Synced ${relativeTime(group.lastSyncedAt)}` : 'Not synced yet',
      txLine: `${group.txCount.toLocaleString()} transaction${group.txCount === 1 ? '' : 's'}`,
      syncChip: walletChainChip(group),
      walletRows: group.rows
    });
  }

  if (input.manualCount > 0) {
    cards.push({
      id: 'manual',
      kind: 'manual',
      lane: 'manual',
      iconId: null,
      iconFallback: 'ME',
      title: 'Manual entry',
      subtitle: 'Typed in one at a time',
      tags: ['Manual entry'],
      status: { tone: 'neutral', label: 'By hand' },
      metaLine: 'Added by hand',
      txLine: `${input.manualCount.toLocaleString()} transaction${input.manualCount === 1 ? '' : 's'}`
    });
  }

  return cards;
}

/** Per-pill card counts (All = every card). */
export function pillCounts(cards: ConnectionCardData[]): Record<PillFilter, number> {
  return {
    all: cards.length,
    exchanges: cards.filter((c) => c.lane === 'exchanges').length,
    wallets: cards.filter((c) => c.lane === 'wallets').length,
    chains: cards.filter((c) => c.lane === 'chains').length,
    manual: cards.filter((c) => c.lane === 'manual').length
  };
}
