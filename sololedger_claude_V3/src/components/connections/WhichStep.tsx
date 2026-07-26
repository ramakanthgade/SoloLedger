import { useMemo, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { Badge } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { ExchangeId } from '@/lib/exchangeSync';
import { AUTO_SYNC_EXCHANGES } from '@/components/import/autoSyncExchanges';
import { IMPORT_SOURCES } from '@/components/import/importSources';
import { BrandIcon } from './brandIcons';
import { WALLET_CATALOG, WALLET_GROUP_ORDER } from './walletCatalog';
import type { FlowKind } from './WhatStep';

/** What the user picked in step 2 — routed by the drawer's Connect step. */
export type WhichSelection =
  | { kind: 'exchange-api'; id: ExchangeId; label: string }
  | { kind: 'exchange-file'; id: string; label: string }
  | { kind: 'wallet-app'; id: string; label: string; preselectChain?: string }
  | { kind: 'chain'; id: string; label: string };

interface WhichStepProps {
  flow: FlowKind;
  /** Slugs that already have a connection or import (shown as "Added"). */
  addedSlugs: string[];
  onPick: (selection: WhichSelection) => void;
}

interface Cell {
  id: string;
  label: string;
  meta: string;
  iconId: string | null;
  added?: boolean;
  selection: WhichSelection;
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

/** Merge the API-sync catalog with the file-import catalog — API wins on overlap. */
function exchangeCells(added: Set<string>): { india: Cell[]; global: Cell[] } {
  const apiIds = new Set(AUTO_SYNC_EXCHANGES.map((e) => e.id as string));
  const apiCells: Cell[] = AUTO_SYNC_EXCHANGES.map((e) => ({
    id: e.id,
    label: e.label,
    meta: 'API auto-sync',
    iconId: e.id,
    added: added.has(e.id),
    selection: { kind: 'exchange-api', id: e.id, label: e.label }
  }));
  const fileCells: Cell[] = IMPORT_SOURCES.filter((s) => !apiIds.has(s.id)).map((s) => ({
    id: s.id,
    label: s.label,
    meta: s.id === 'other' ? 'Any CSV / Excel' : 'File import',
    iconId: FILE_SOURCE_ICONS.has(s.id) ? s.id : null,
    added: added.has(s.id),
    selection: { kind: 'exchange-file', id: s.id, label: s.label }
  }));
  const indiaSources = new Set(IMPORT_SOURCES.filter((s) => s.region === 'india').map((s) => s.id));
  const all = [...apiCells, ...fileCells];
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
export function WhichStep({ flow, addedSlugs, onPick }: WhichStepProps) {
  const [query, setQuery] = useState('');
  const added = useMemo(() => new Set(addedSlugs), [addedSlugs]);

  const sections: { heading: string | null; cells: Cell[] }[] = useMemo(() => {
    if (flow === 'exchange') {
      const { india, global } = exchangeCells(added);
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
          added: added.has(w.id),
          selection: {
            kind: 'wallet-app',
            id: w.id,
            label: w.name,
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
            added: added.has(c.id),
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
  }, [flow, added]);

  const q = query.trim().toLowerCase();
  const visible = sections
    .map((s) => ({
      ...s,
      cells: q ? s.cells.filter((c) => c.label.toLowerCase().includes(q)) : s.cells
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
            {section.cells.map((cell) => (
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
                <BrandIcon id={cell.iconId} fallback={cell.label} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold text-hi">{cell.label}</span>
                  <span className="block text-[11px] text-low">{cell.meta}</span>
                </span>
                {cell.added ? (
                  <Badge tone="gain">Added</Badge>
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
