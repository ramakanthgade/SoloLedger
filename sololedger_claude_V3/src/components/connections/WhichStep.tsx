import { useMemo, useState } from 'react';
import { Check, ChevronRight, Search, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { ExchangeId } from '@/lib/exchangeSync';
import { AUTO_SYNC_EXCHANGES } from '@/components/import/autoSyncExchanges';
import { IMPORT_SOURCES } from '@/components/import/importSources';
import { BrandIcon } from './brandIcons';
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
  /** Generic affordance (not a brand) — render the neutral lucide glyph chip. */
  genericGlyph?: 'wallet';
  added?: boolean;
  selection: WhichSelection;
  modes?: Array<{
    kind: 'file' | 'api';
    label: string;
    hint: string;
    active: boolean;
    tone?: 'primary' | 'gain' | 'warn';
    selection: WhichSelection;
  }>;
}

/** Chains offered as one-tap picks; everything else stays reachable in the form. */
const CHAIN_PICKS: { id: string; label: string }[] = [
  { id: 'bitcoin', label: 'Bitcoin' },
  { id: 'ethereum', label: 'Ethereum' },
  { id: 'solana', label: 'Solana' },
  { id: 'polygon', label: 'Polygon' },
  { id: 'bsc', label: 'BNB Smart Chain' }
];

/** File-only exchanges that have a real brand logo in the registry. */
const FILE_SOURCE_ICONS = new Set(['coindcx', 'coinswitch', 'zebpay', 'wazirx']);

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
      meta: source.id === 'other' ? 'Any CSV / Excel' : 'File import',
      iconId: FILE_SOURCE_ICONS.has(source.id) || source.id === 'binance' || source.id === 'coinbase' ? source.id : null,
      added: fileImported.has(source.id),
      selection,
      modes: [{ kind: 'file', label: fileImported.has(source.id) ? 'CSV imported' : 'File import', hint: 'CSV export', active: fileImported.has(source.id), selection }]
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
              : 'API auto-sync',
      hint: apiState === 'connected' ? 'Ready to sync' : 'Read-only key',
      active: apiState !== undefined,
      tone: apiState === 'synced' ? 'gain' as const : apiState === 'attention' ? 'warn' as const : 'primary' as const,
      selection
    };
    if (existing) {
      existing.meta = 'Supports file import and API auto-sync';
      existing.iconId = exchange.id;
      existing.modes = [...(existing.modes ?? []), apiMode];
    } else {
      byId.set(exchange.id, {
        id: exchange.id,
        label: exchange.label,
        meta: 'API auto-sync',
        iconId: exchange.id,
        added: apiState !== undefined,
        selection,
        modes: [apiMode]
      });
    }
  }
  const indiaSources = new Set(IMPORT_SOURCES.filter((s) => s.region === 'india').map((s) => s.id));
  const all = Array.from(byId.values());
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
    // chain
    return [
      {
        heading: null,
        cells: [
          ...CHAIN_PICKS.map((c) => ({
            id: c.id,
            label: c.label,
            meta: c.id === 'bitcoin' ? 'Address or xPub' : 'Public address',
            iconId: c.id,
            added: false,
            selection: { kind: 'chain', id: c.id, label: c.label } as WhichSelection
          })),
          {
            id: '__any',
            label: 'Another chain',
            meta: 'Pick from the full list next',
            iconId: null,
            selection: { kind: 'chain', id: '__any', label: 'Another chain' } as WhichSelection
          }
        ]
      }
    ];
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
            const label = c.label.toLowerCase();
            return tokens.every((t) => label.includes(t));
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
          <div className="flex flex-col gap-2">
            {section.cells.map((cell) => cell.modes && cell.modes.length > 1 ? (
              <div
                key={cell.id}
                className="flex min-h-11 flex-wrap items-start gap-3 rounded-xl border border-hi/10 bg-elev-1 px-3.5 py-2.5"
                aria-label={`${cell.label} — choose file import or API auto-sync`}
                data-testid={`exchange-row-${cell.id}`}
              >
                <BrandIcon id={cell.iconId} fallback={cell.label} size={32} />
                <span className="min-w-[8rem] flex-1">
                  <span className="block text-sm font-bold text-hi">{cell.label}</span>
                  <span className="block text-[11px] text-low">{cell.meta}</span>
                </span>
                <span className="flex flex-wrap gap-2">
                  {cell.modes.map((mode) => (
                    <button
                      key={mode.kind}
                      type="button"
                      onClick={() => onPick(mode.selection)}
                      aria-label={`${cell.label} ${mode.label}`}
                      data-testid={`${cell.id}-mode-${mode.kind}`}
                      className={cn(
                        'flex min-w-[118px] items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs font-semibold transition-colors',
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
                      <span className="min-w-0 flex-1">
                        <span className="block">{mode.label}</span>
                        <span className="block text-[10px] font-normal opacity-70">{mode.hint}</span>
                      </span>
                      {!mode.active && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden="true" />}
                    </button>
                  ))}
                </span>
              </div>
            ) : (
              <button
                key={cell.id}
                type="button"
                onClick={() => onPick(cell.selection)}
                className={cn(
                  'relative flex min-h-11 w-full items-center gap-3 rounded-xl border border-hi/10 bg-elev-1 px-3.5 py-2.5 text-left',
                  'transition-colors hover:border-primary/40 hover:bg-primary/[0.04]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60'
                )}
              >
                {cell.genericGlyph === 'wallet' ? (
                  // Generic "Any other wallet" affordance — a neutral lucide
                  // glyph chip; the aurora letter-chip fallback must NOT kick in.
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
                  <span className="block text-[11px] text-low">{cell.meta}</span>
                </span>
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
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
