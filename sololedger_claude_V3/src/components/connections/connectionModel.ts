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

/** Group lookup rows by address (case-insensitive) into wallet cards. */
export function groupWallets(rows: LookupAddressRow[]): WalletGroup[] {
  const byAddress = new Map<string, LookupAddressRow[]>();
  for (const row of rows) {
    const key = row.address.toLowerCase();
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

/** Wallet-app heuristic: labeled after a known wallet app, or multi-chain. */
export function walletLane(group: WalletGroup): 'wallets' | 'chains' {
  const label = group.label?.toLowerCase() ?? '';
  if (label && WALLET_APP_NAMES.some((name) => label.includes(name))) return 'wallets';
  return group.chains.length > 1 ? 'wallets' : 'chains';
}

function chainLabel(chainId: string): string {
  return CHAINS.find((c) => c.id === chainId)?.label ?? chainId;
}

/** Display title for a file import: the exchange it came from, else the file name. */
export function fileImportTitle(row: CsvImportRow): string {
  const parserSlug = row.parserId?.split('_')[0];
  if (row.parserId && parserIconId(row.parserId)) return brandLabel(parserIconId(row.parserId)!);
  const source = getImportSource(parserSlug ?? null);
  if (source) return source.label;
  return shortFileName(row.fileName);
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
    cards.push({
      id: `exchange:${c.id}`,
      kind: 'exchange-api',
      lane: 'exchanges',
      iconId: c.exchange,
      iconFallback: meta?.monogram ?? c.exchange,
      title: c.label?.trim() ? `${meta?.label ?? c.exchange} · ${c.label.trim()}` : (meta?.label ?? c.exchange),
      subtitle: 'API auto-sync',
      tags: ['Exchange', 'API auto-sync'],
      status: syncing
        ? { tone: 'primary', label: 'Syncing' }
        : c.lastError != null
          ? { tone: 'warn', label: 'Needs attention' }
          : { tone: 'gain', label: 'Synced' },
      metaLine: c.lastSyncAt != null ? `Synced ${relativeTime(c.lastSyncAt)}` : 'Not synced yet',
      txLine: `${c.txCount.toLocaleString()} transaction${c.txCount === 1 ? '' : 's'}`,
      error: c.lastError,
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
      status: { tone: 'primary', label: 'Imported' },
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
      metaLine: `Synced ${relativeTime(group.lastSyncedAt)}`,
      txLine: `${group.txCount.toLocaleString()} transaction${group.txCount === 1 ? '' : 's'}`,
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
