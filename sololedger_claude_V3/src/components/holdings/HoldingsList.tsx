import { AssetIcon } from '@/components/portfolio/AssetIcon';
import { PROTOCOL_REGISTRY } from '@/lib/defi/protocolRegistry';
import type { ProtocolId } from '@/lib/defi/types';
import type { EconomicExposureProjection, EconomicExposureRow } from '@/lib/portfolio/economicExposureProjection';
import { formatCompactAmount } from '@/lib/utils';

export function HoldingsList({ projection, formatMoney }: {
  projection: EconomicExposureProjection;
  formatMoney: (value: number) => string;
}) {
  const protocolRows = [...projection.assets, ...projection.liabilities].filter((row) => row.kind !== 'liquid' && row.protocolId) as EconomicExposureRow[];
  const sections = (Object.keys(PROTOCOL_REGISTRY) as ProtocolId[]).flatMap((protocolId) => {
    const displayRows = protocolRows.filter((row) => row.protocolId === protocolId);
    return displayRows.length ? [{ protocolId, displayRows }] : [];
  });
  if (!sections.length) return null;
  return <div className="border-t border-hi/10" data-testid="protocol-holdings-list">
    {(projection.status === 'stale' || projection.status === 'unsupported') && (
      <p className="bg-warn/10 px-5 py-2 text-xs text-warn" role="status">
        Protocol authority is {projection.status}; raw custody remains protected.
      </p>
    )}
    {sections.map(({ protocolId, displayRows }) => {
      const registry = PROTOCOL_REGISTRY[protocolId];
      const sectionHasUnpricedValues = displayRows.some((row) => row.contribution == null);
      const signedTotal = displayRows.some((row) => row.contribution == null) ? null : displayRows.reduce((sum, row) => sum + row.contribution!, 0);
      return <section key={protocolId} aria-label={`${registry.protocol} ${registry.version} positions`} className="border-b border-hi/10 last:border-b-0">
        <div className="flex flex-wrap items-center gap-2 bg-elev-1/60 px-5 py-2.5">
          <span className="text-xs font-bold text-hi">{registry.protocol} {registry.version}</span>
          {signedTotal != null && <span className="ml-auto text-xs font-bold tabular-figures text-mid">Net {formatMoney(signedTotal)}</span>}
        </div>
        {sectionHasUnpricedValues && <p className="bg-warn/10 px-5 py-2 text-xs text-warn" role="status">Some position values are unavailable; unpriced rows are shown explicitly.</p>}
        {displayRows.length > 0 && <ul>{displayRows.map((row) => <li
          key={row.id}
          className="flex items-center gap-3 border-t border-hi/10 px-5 py-3"
          data-economic-value={row.contribution ?? undefined}
        >
          <AssetIcon symbol={row.symbol} size={30} />
          <div className="min-w-0 flex-1"><p className="text-sm font-bold text-hi">{row.symbol}</p><p className="text-xs text-low">{row.kind === 'supply' ? `Supplied${row.isCollateral ? ' · Collateral' : ' · Not collateral'}` : `Liability · ${row.debtRateMode}`}</p></div>
          <div className="text-right"><p className="text-sm font-semibold tabular-figures text-hi">{row.kind === 'liability' ? 'Owed ' : ''}{formatCompactAmount(row.quantity)}</p><p className="text-xs tabular-figures text-low">{row.value != null ? `${row.kind === 'liability' ? '−' : ''}${formatMoney(row.value)}` : 'Unpriced'}</p></div>
        </li>)}</ul>}
      </section>;
    })}
  </div>;
}
