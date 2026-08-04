import { useMemo, useState } from 'react';
import { Check, ChevronRight, Search, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { ExchangeId } from '@/lib/exchangeSync';
import { AUTO_SYNC_EXCHANGES } from '@/components/import/autoSyncExchanges';
import { IMPORT_SOURCES } from '@/components/import/importSources';
import { CHAINS, DROPDOWN_HIDDEN_CHAINS } from '@/lib/rpc/providers';
import { BrandIcon, chainIconId } from './brandIcons';
import { ANY_WALLET_DEFAULT_NAME, ANY_WALLET_ID, WALLET_CATALOG, WALLET_GROUP_ORDER } from './walletCatalog';
import type { FlowKind } from './WhatStep';

/** What the user picked in step 2 — routed by the drawer's Connect step. */
export type WhichSelection =
  | { kind: 'exchange-api'; id: ExchangeId; label: string }
  | { kind: 'exchange-file'; id: string; label: string }
  | { kind: 'wallet-app'; id: string; label: string; preselectChain?: string }
  | { kind: 'chain'; id: string; label: string };

export type ApiExchangeState = 'connected' | 'synced' | 'attention';
export type ApiExchangeStates = Partial<Record<ExchangeId, ApiExchangeState>>;

interface WhichStepProps {
  flow: FlowKind;
  apiExchangeStates: ApiExchangeStates;
  fileImportedSlugs: string[];
  onPick: (selection: WhichSelection) => void;
}

interface Cell {
  id: string;
  label: string;
  meta: string;
  iconId: string | null;
  searchText?: string;
  /** Generic affordance (not a brand) — render the neutral lucide glyph chip. */
  genericGlyph?: 'wallet';
  capability?: { label: string; tone: 'neutral' | 'primary' | 'warn' };
  added?: boolean;
  selection: WhichSelection;
  modes?: Array<{
    kind: 'file' | 'api';
    label: string;
    hint: string;
    capability: string;
    capabilityTone: 'neutral' | 'primary' | 'warn';
    active: boolean;
    tone?: 'primary' | 'gain' | 'warn';
    selection: WhichSelection;
  }>;
}

const POPULAR_CHAIN_IDS = [
  'bitcoin',
  'ethereum',
  'solana',
  'polygon',
  'bsc',
  'arbitrum',
  'base',
  'optimism',
  'avalanche'
] as const;

/** Merge catalogs by exchange identity while keeping each mode independent. */
function exchangeCells(
  apiExchangeStates: ApiExchangeStates,
  fileImported: Set<string>
): { india: Cell[]; global: Cell[] } {
  const byId = new Map<string, Cell>();
  for (const source of IMPORT_SOURCES) {
    const selection: WhichSelection = { kind: 'exchange-file', id: source.id, label: source.label };
    byId.set(source.id, {
      id: source.id,
      label: source.label,
      meta: source.id === 'other' ? 'Any CSV / Excel' : source.formatHint,
      searchText: `${source.id} ${source.formatHint}`,
      iconId: source.id === 'other' ? null : source.id,
      added: fileImported.has(source.id),
      selection,
      modes: [{
        kind: 'file',
        label: fileImported.has(source.id) ? 'CSV imported' : 'Import file',
        hint: source.formatHint,
        capability:
          source.fileSupport === 'verified'
            ? 'Verified file import'
            : source.fileSupport === 'schema-beta'
              ? 'Schema-compatible beta'
              : 'Flexible file import',
        capabilityTone: source.fileSupport === 'schema-beta' ? 'warn' : source.fileSupport === 'verified' ? 'primary' : 'neutral',
        active: fileImported.has(source.id),
        selection
      }]
    });
  }
  for (const exchange of AUTO_SYNC_EXCHANGES) {
    const selection: WhichSelection = { kind: 'exchange-api', id: exchange.id, label: exchange.label };
    const existing = byId.get(exchange.id);
    const apiState = apiExchangeStates[exchange.id];
    const apiMode = {
      kind: 'api' as const,
      label:
        apiState === 'synced'
          ? 'API synced'
          : apiState === 'connected'
            ? 'API connected'
            : apiState === 'attention'
              ? 'Needs attention'
              : 'Connect API',
      hint: apiState === 'connected' ? 'Ready to sync' : 'Read-only key',
      capability: 'API sync',
      capabilityTone: 'primary' as const,
      active: apiState !== undefined,
      tone: apiState === 'synced' ? 'gain' as const : apiState === 'attention' ? 'warn' as const : 'primary' as const,
      selection
    };
    if (existing) {
      existing.meta = 'File import + API sync';
      existing.iconId = exchange.id;
      existing.modes = [...(existing.modes ?? []), apiMode];
    } else {
      byId.set(exchange.id, {
        id: exchange.id,
        label: exchange.label,
        meta: 'API sync with read-only credentials',
        iconId: exchange.id,
        added: apiState !== undefined,
        selection,
        modes: [apiMode]
      });
    }
  }
  const indiaSources = new Set(IMPORT_SOURCES.filter((s) => s.region === 'india').map((s) => s.id));
  // Map insertion order follows the file catalog, but keep the generic escape
  // hatch explicitly last even after the API and file catalogs are merged.
  const all = Array.from(byId.values()).sort((a, b) =>
    a.id === 'other' ? 1 : b.id === 'other' ? -1 : 0
  );
  return {
    india: all.filter((c) => indiaSources.has(c.id)),
    global: all.filter((c) => !indiaSources.has(c.id))
  };
}

/**
 * Drawer step 2 — "Which one?" Search-anything box plus brand-logo grids:
 * Popular in India / More exchanges for exchange accounts, the wallet-app
 * grid, or the chain grid. Cells with an existing connection show "Added".
 */
export function WhichStep({ flow, apiExchangeStates, fileImportedSlugs, onPick }: WhichStepProps) {
  const [query, setQuery] = useState('');
  const fileImported = useMemo(() => new Set(fileImportedSlugs), [fileImportedSlugs]);

  const sections: { heading: string | null; cells: Cell[] }[] = useMemo(() => {
    if (flow === 'exchange') {
      const { india, global } = exchangeCells(apiExchangeStates, fileImported);
      return [
        { heading: 'Popular in India', cells: india },
        { heading: 'More exchanges', cells: global }
      ];
    }
    if (flow === 'wallet-app') {
      // Data-driven catalog, sectioned by ecosystem (group order locked in walletCatalog).
      return WALLET_GROUP_ORDER.map((group) => ({
        heading: group as string,
        cells: WALLET_CATALOG.filter((w) => w.group === group).map((w) => ({
          id: w.id,
          label: w.name,
          meta: w.subtitle,
          iconId: w.logo ? w.id : null,
          genericGlyph: w.genericGlyph,
          added: false,
          selection: {
            kind: 'wallet-app',
            id: w.id,
            // The generic tile prefills the connect form's (required) wallet
            // name with "My wallet"; brand tiles prefill the app name.
            label: w.id === ANY_WALLET_ID ? ANY_WALLET_DEFAULT_NAME : w.name,
            preselectChain: w.chains[0]
          } as WhichSelection
        }))
      })).filter((s) => s.cells.length > 0);
    }
    // First-step discovery includes only standard provider-wired built-ins.
    // Unsupported, legacy-hidden and per-connection explorer/BYOK chains stay
    // available only in the full WalletAddressForm dropdown for compatibility.
    const actionable = CHAINS.filter(
      (chain) =>
        !DROPDOWN_HIDDEN_CHAINS.has(chain.id) &&
        (chain.provider === 'blockstream' ||
          chain.provider === 'alchemy_solana' ||
          chain.provider === 'alchemy_evm')
    );
    const byChainId = new Map(actionable.map((chain) => [chain.id, chain]));
    const popular = POPULAR_CHAIN_IDS.flatMap((id) => {
      const chain = byChainId.get(id);
      return chain ? [chain] : [];
    });
    const popularIds = new Set(popular.map((chain) => chain.id));
    const standard = actionable.filter((chain) => !popularIds.has(chain.id));
    const toCell = (chain: (typeof CHAINS)[number]): Cell => ({
      id: chain.id,
      label: chain.label,
      meta:
        chain.id === 'bitcoin'
          ? 'Bitcoin address or xPub'
          : 'Public wallet address',
      searchText: `${chain.id} ${chain.asset} ${chain.provider}`,
      iconId: chainIconId(chain.id) ?? null,
      capability: { label: 'Address support', tone: 'primary' },
      added: false,
      selection: { kind: 'chain', id: chain.id, label: chain.label }
    });
    return [
      { heading: 'Popular supported chains', cells: popular.map(toCell) },
      { heading: 'More supported chains', cells: standard.map(toCell) }
    ].filter((section) => section.cells.length > 0);
  }, [flow, apiExchangeStates, fileImported]);

  const q = query.trim().toLowerCase();
  // Tokenized match: every word must appear in the label, so "any wallet"
  // still finds "Any other wallet" (D-5) and "trust wallet" finds "Trust Wallet".
  const tokens = q.split(/\s+/).filter(Boolean);
  const visible = sections
    .map((s) => ({
      ...s,
      cells: tokens.length
        ? s.cells.filter((c) => {
            const searchable = `${c.label} ${c.meta} ${c.id} ${c.searchText ?? ''}`.toLowerCase();
            return tokens.every((t) => searchable.includes(t));
          })
        : s.cells
    }))
    .filter((s) => s.cells.length > 0);

  const placeholder =
    flow === 'exchange'
      ? 'Search exchanges…'
      : flow === 'wallet-app'
        ? 'Search wallet apps…'
        : 'Search chains…';

  return (
    <div className="flex flex-col gap-4" data-testid="addflow-which">
      <label className="relative block">
        <span className="sr-only">{placeholder}</span>
        <Search
          className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-faint"
          aria-hidden="true"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          data-testid="addflow-search"
          className="h-12 w-full rounded-lg border border-hi/10 bg-elev-1 pl-11 pr-3.5 text-sm text-hi shadow-xs transition-colors placeholder:text-faint hover:border-hi/20 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </label>

      {flow === 'exchange' && (
        <div className="rounded-xl border border-hi/10 bg-elev-2 px-3.5 py-3 text-xs leading-relaxed text-low">
          <strong className="font-bold text-mid">Choose how to add data.</strong>{' '}
          API sync is easiest to maintain; always use read-only keys. File import works best for
          one-time setup or historical data.
        </div>
      )}

      {visible.length === 0 && (
        <p className="py-6 text-center text-sm text-low">
          Nothing matches “{query.trim()}”. Try a different name.
        </p>
      )}

      {visible.map((section) => (
        <div key={section.heading ?? 'all'}>
          {section.heading && (
            <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.09em] text-low">
              {section.heading}
            </p>
          )}
          <div className={cn(flow === 'exchange' ? 'flex flex-col gap-2' : 'grid grid-cols-1 gap-2 sm:grid-cols-2')}>
            {section.cells.map((cell) => cell.modes && cell.modes.length > 0 ? (
              <div
                key={cell.id}
                className="grid min-h-11 grid-cols-[32px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-xl border border-hi/10 bg-elev-1 px-3 py-2"
                aria-label={`${cell.label} import options`}
                data-testid={`exchange-row-${cell.id}`}
              >
                <BrandIcon id={cell.iconId} fallback={cell.label} size={32} />
                <span className="min-w-[8rem] flex-1">
                  <span className="block text-sm font-bold text-hi">{cell.label}</span>
                  <span className="block text-[11px] text-low">{cell.meta}</span>
                </span>
                <span className="col-span-2 grid grid-cols-1 gap-2">
                  {cell.modes.map((mode) => (
                    <button
                      key={mode.kind}
                      type="button"
                      onClick={() => onPick(mode.selection)}
                      aria-label={`${cell.label} ${mode.label} · ${mode.capability}`}
                      title={mode.hint}
                      data-testid={`${cell.id}-mode-${mode.kind}`}
                      className={cn(
                        'flex min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left text-xs font-semibold transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                        mode.active
                          ? mode.kind === 'file' || mode.tone === 'primary'
                            ? 'border-primary/30 bg-primary/10 text-primary'
                            : mode.tone === 'warn'
                              ? 'border-warn/30 bg-warn/10 text-warn'
                              : 'border-gain/30 bg-gain/10 text-gain'
                          : 'border-hi/10 bg-elev-1 text-mid hover:border-primary/40 hover:bg-primary/[0.04]'
                      )}
                    >
                      {mode.active && <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={3} aria-hidden="true" />}
                      <Badge tone={mode.capabilityTone} className="px-1.5 py-0 text-[9px] leading-3">
                        <span>{mode.capability}</span>
                      </Badge>
                      <span className="min-w-0 flex-1 truncate">{mode.label}</span>
                      {!mode.active && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden="true" />}
                    </button>
                  ))}
                </span>
              </div>
            ) : (
              <button
                key={cell.id}
                type="button"
                data-testid={`choice-${flow}-${cell.id}`}
                onClick={() => onPick(cell.selection)}
                className={cn(
                  'relative min-h-11 w-full rounded-xl border border-hi/10 bg-elev-1 px-3 py-2.5 text-left',
                  cell.capability
                    ? 'grid grid-cols-[32px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1.5'
                    : 'flex items-center gap-3',
                  'transition-colors hover:border-primary/40 hover:bg-primary/[0.04]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60'
                )}
              >
                {cell.genericGlyph ? (
                  // Generic wallet affordances use a neutral lucide glyph.
                  <span
                    aria-hidden="true"
                    data-testid="any-wallet-glyph"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-hi/10 bg-elev-2 text-mid"
                  >
                    <Wallet className="h-4 w-4" aria-hidden="true" />
                  </span>
                ) : (
                  <BrandIcon id={cell.iconId} fallback={cell.label} size={32} />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold text-hi">{cell.label}</span>
                  <span className={cn('text-[11px] text-low', cell.capability ? 'sr-only' : 'block')}>{cell.meta}</span>
                </span>
                {cell.capability && (
                  <Badge tone={cell.capability.tone} className="col-span-2 justify-self-start px-2 py-0 text-[10px]">
                    {cell.capability.label}
                  </Badge>
                )}
                {cell.added ? (
                  <Badge
                    tone={
                      cell.modes?.[0]?.kind === 'file'
                        ? 'primary'
                        : cell.modes?.[0]?.tone ?? 'gain'
                    }
                  >
                    {cell.modes?.[0]?.label ?? 'Added'}
                  </Badge>
                ) : !cell.capability ? (
                  <ChevronRight className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
