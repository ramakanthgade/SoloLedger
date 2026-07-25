import { ChartCandlestick, ChevronRight, FileUp, Globe, PenLine, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';

export type FlowKind = 'exchange' | 'wallet-app' | 'chain' | 'file' | 'manual';

interface WhatStepProps {
  onPick: (flow: FlowKind) => void;
}

const TILES: {
  flow: FlowKind;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  iconCls: string;
}[] = [
  {
    flow: 'exchange',
    title: 'Exchange account',
    subtitle: 'Binance, CoinDCX, WazirX… API key or file',
    icon: <ChartCandlestick className="h-5 w-5" aria-hidden="true" />,
    iconCls: 'bg-primary/10 text-primary'
  },
  {
    flow: 'wallet-app',
    title: 'Wallet app',
    subtitle: 'MetaMask, Trust, Ledger, Phantom',
    icon: <Wallet className="h-5 w-5" aria-hidden="true" />,
    iconCls: 'bg-gain/10 text-gain'
  },
  {
    flow: 'chain',
    title: 'Blockchain address',
    subtitle: 'BTC, ETH, SOL — any public address or xPub',
    icon: <Globe className="h-5 w-5" aria-hidden="true" />,
    iconCls: 'bg-accent/10 text-accent'
  },
  {
    flow: 'file',
    title: 'A file',
    subtitle: 'CSV / XLSX export from any exchange or wallet',
    icon: <FileUp className="h-5 w-5" aria-hidden="true" />,
    iconCls: 'bg-warn/10 text-warn'
  },
  {
    flow: 'manual',
    title: 'Manual entry',
    subtitle: 'One transaction at a time, typed in by hand',
    icon: <PenLine className="h-5 w-5" aria-hidden="true" />,
    iconCls: 'bg-loss/10 text-loss'
  }
];

/**
 * Drawer step 1 — "What are you adding?" Five source-type tiles (mockup
 * `.ttile`). Picking one advances the rail to Which (or straight to Connect
 * for file/manual, which have nothing to pick).
 */
export function WhatStep({ onPick }: WhatStepProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="addflow-what">
      <div className="mb-1">
        <p className="text-lg font-extrabold tracking-tight text-hi">What are you adding?</p>
        <p className="mt-1 text-[13px] text-mid">
          Pick a source type — add as many as you like, in any order.
        </p>
      </div>
      {TILES.map((tile) => (
        <button
          key={tile.flow}
          type="button"
          onClick={() => onPick(tile.flow)}
          className={cn(
            'flex min-h-11 w-full items-center gap-3.5 rounded-xl border border-hi/10 bg-elev-1 px-4 py-3.5 text-left',
            'transition-colors hover:border-primary/40 hover:bg-primary/[0.04]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60'
          )}
        >
          <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', tile.iconCls)}>
            {tile.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-bold text-hi">{tile.title}</span>
            <span className="mt-0.5 block text-xs text-low">{tile.subtitle}</span>
          </span>
          <ChevronRight className="h-[18px] w-[18px] shrink-0 text-faint" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
