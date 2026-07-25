import { useId, useMemo, useRef, useState } from 'react';
import type { ChartPoint } from '@/lib/dashboard/dashboardModel';
import { shortDateLabel } from '@/lib/dashboard/dashboardModel';
import { formatCurrency } from '@/lib/utils';

/**
 * Net-worth area chart — hand-rolled SVG (no chart dependency), matching the
 * dashboard mock's smooth area + dashed cost-basis line + hover tooltip.
 *
 * Data honesty: the solid area is market value (qty × last cached daily
 * close); the dashed line is cumulative cost basis from the portfolio engine.
 * Both series come from `buildChartSeries` — nothing is interpolated beyond
 * last-known-close steps, and the caller labels the chart when prices are
 * missing.
 */

const W = 1000;
const H = 240;
const PAD_TOP = 14;
const PAD_BOTTOM = 28;
const PAD_X = 6;
const DAY_MS = 86_400_000;

interface Pt {
  x: number;
  y: number;
}

const xOf = (t: number, start: number, end: number) =>
  PAD_X + ((t - start) / Math.max(1, end - start)) * (W - 2 * PAD_X);
const yOf = (v: number, minV: number, maxV: number) =>
  H - PAD_BOTTOM - ((v - minV) / Math.max(1e-9, maxV - minV)) * (H - PAD_TOP - PAD_BOTTOM);

/** Catmull-Rom → cubic bezier smoothing (the mock's flowing area line). */
function smoothPath(pts: Pt[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

interface Tick {
  frac: number;
  label: string;
}

/** Month ticks for long spans, ~weekly date ticks for short ones. */
function xTicks(start: number, end: number): Tick[] {
  const span = end - start;
  if (span <= 0) return [];
  if (span <= 45 * DAY_MS) {
    const step = 7 * DAY_MS;
    const first = Math.ceil(start / step) * step;
    const ticks: Tick[] = [];
    for (let t = first; t < end; t += step) {
      ticks.push({ frac: (t - start) / span, label: shortDateLabel(t) });
    }
    return ticks;
  }
  const ticks: Tick[] = [];
  const cursor = new Date(start);
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  if (cursor.getTime() <= start) cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  const withYear = span > 400 * DAY_MS;
  while (cursor.getTime() < end && ticks.length < 8) {
    const t = cursor.getTime();
    const label = shortDateLabel(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1)).split(' ')[0];
    ticks.push({
      frac: (t - start) / span,
      label: withYear ? `${label} '${String(cursor.getUTCFullYear()).slice(-2)}` : label
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return ticks;
}

export interface NetWorthChartProps {
  points: ChartPoint[];
  /** 'market' draws the solid area on the market series; 'cost' on cost. */
  mode: 'market' | 'cost';
  currency: string;
  /** Privacy mode — tooltip values render as ••••. */
  mask?: boolean;
}

export function NetWorthChart({ points, mode, currency, mask = false }: NetWorthChartProps) {
  const gradientId = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const { start, end, minV, maxV } = useMemo(() => {
    if (points.length === 0) return { start: 0, end: 1, minV: 0, maxV: 1 };
    let max = 0;
    let min = Infinity;
    for (const p of points) {
      max = Math.max(max, p.cost, p.market ?? 0);
      min = Math.min(min, p.cost, p.market ?? Infinity);
    }
    // Zoom the y-domain to the data when everything sits far above zero —
    // otherwise a healthy portfolio reads as a flat line glued to the top.
    const zoomed = min > 0 && max > min;
    return {
      start: points[0].t,
      end: points[points.length - 1].t,
      minV: zoomed ? min * 0.94 : 0,
      maxV: max > 0 ? max * (zoomed ? 1.04 : 1.06) : 1
    };
  }, [points]);

  const costPts = useMemo(
    () => points.map((p) => ({ x: xOf(p.t, start, end), y: yOf(p.cost, minV, maxV) })),
    [points, start, end, minV, maxV]
  );
  const marketPts = useMemo(
    () =>
      points
        .filter((p) => p.market != null)
        .map((p) => ({ x: xOf(p.t, start, end), y: yOf(p.market!, minV, maxV) })),
    [points, start, end, minV, maxV]
  );

  const solidPts = mode === 'market' && marketPts.length > 1 ? marketPts : costPts;
  const solidPath = smoothPath(solidPts);
  const areaPath =
    solidPts.length > 1
      ? `${solidPath} L${solidPts[solidPts.length - 1].x},${H - PAD_BOTTOM} L${solidPts[0].x},${H - PAD_BOTTOM} Z`
      : '';
  const costPath = smoothPath(costPts);
  const ticks = xTicks(start, end);

  const money = (v: number) => (mask ? '••••' : formatCurrency(v, currency));
  const dateLabel = (t: number) => {
    const d = new Date(t);
    return `${shortDateLabel(t)} ${d.getUTCFullYear()}`;
  };

  const onMove = (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || points.length === 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const t = start + frac * (end - start);
    // nearest sampled point
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dist = Math.abs(points[i].t - t);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    setHover(best);
  };

  const hoverPoint = hover != null ? points[hover] : null;
  const hoverXFrac = hoverPoint ? (hoverPoint.t - start) / Math.max(1, end - start) : 0;
  const hoverValue = hoverPoint ? (mode === 'market' ? (hoverPoint.market ?? hoverPoint.cost) : hoverPoint.cost) : 0;
  const hoverYFrac = hoverPoint ? 1 - (hoverValue - minV) / Math.max(1e-9, maxV - minV) : 0;

  const first = points[0];
  const last = points[points.length - 1];
  const ariaSummary =
    points.length > 1
      ? `Net worth chart, ${mode === 'market' ? 'market value' : 'cost basis'}, ${dateLabel(first.t)} to ${dateLabel(last.t)}: ${money(
          mode === 'market' ? (first.market ?? first.cost) : first.cost
        )} to ${money(mode === 'market' ? (last.market ?? last.cost) : last.cost)}. Dashed line: cost basis.`
      : 'Net worth chart — not enough history yet.';

  return (
    <div className="relative" data-testid="net-worth-chart">
      <div
        ref={wrapRef}
        className="relative"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={ariaSummary}
          className="block"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--primary)" stopOpacity="0.20" />
              <stop offset="1" stopColor="var(--primary)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* grid */}
          {[0.25, 0.5, 0.75, 1].map((f) => {
            const y = PAD_TOP + (1 - f) * (H - PAD_TOP - PAD_BOTTOM);
            return (
              <line
                key={f}
                x1={PAD_X}
                y1={y}
                x2={W - PAD_X}
                y2={y}
                stroke="rgb(var(--text-faint-rgb) / 0.30)"
                strokeWidth="1"
              />
            );
          })}

          {/* solid area + line */}
          {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
          {solidPath && (
            <path
              d={solidPath}
              fill="none"
              stroke="var(--primary)"
              strokeWidth="2.4"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* dashed cost-basis line */}
          {mode === 'market' && costPath && (
            <path
              d={costPath}
              fill="none"
              stroke="var(--text-low)"
              strokeWidth="1.4"
              strokeDasharray="5 5"
              vectorEffect="non-scaling-stroke"
              opacity="0.85"
            />
          )}

          {/* hover guide + dot */}
          {hoverPoint && (
            <>
              <line
                x1={xOf(hoverPoint.t, start, end)}
                y1={PAD_TOP}
                x2={xOf(hoverPoint.t, start, end)}
                y2={H - PAD_BOTTOM}
                stroke="rgb(var(--text-faint-rgb) / 0.55)"
                strokeWidth="1"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={xOf(hoverPoint.t, start, end)}
                cy={yOf(hoverValue, minV, maxV)}
                r="4.5"
                fill="var(--bg-elev-1)"
                stroke="var(--primary)"
                strokeWidth="2.4"
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}

          {/* x labels */}
          {ticks.map((tick) => (
            <text
              key={tick.label + tick.frac}
              x={PAD_X + tick.frac * (W - 2 * PAD_X)}
              y={H - 8}
              fontSize="11"
              fontWeight="700"
              fill="var(--text-low)"
              textAnchor="middle"
              style={{ letterSpacing: '0.06em', textTransform: 'uppercase' }}
            >
              {tick.label}
            </text>
          ))}
        </svg>

        {/* HTML tooltip (values, not distorted by preserveAspectRatio) */}
        {hoverPoint && (
          <div
            className="pointer-events-none absolute z-10 min-w-[9.5rem] -translate-x-1/2 rounded-xl border border-hi/10 bg-hi px-3 py-2 text-canvas shadow-pop"
            style={{
              left: `${Math.min(88, Math.max(12, hoverXFrac * 100))}%`,
              top: `${Math.max(0, hoverYFrac * 76)}%`
            }}
            data-testid="chart-tooltip"
          >
            <p className="text-[0.6875rem] font-bold uppercase tracking-wider opacity-75">
              {dateLabel(hoverPoint.t)}
            </p>
            {mode === 'market' && hoverPoint.market != null && (
              <p className="mt-0.5 text-sm font-bold tabular-figures">{money(hoverPoint.market)}</p>
            )}
            <p className="mt-0.5 flex items-center gap-1.5 text-[0.6875rem] font-semibold tabular-figures opacity-85">
              <span
                aria-hidden="true"
                className="inline-block w-4 border-t-2 border-dashed border-canvas/70"
              />
              Cost basis {money(hoverPoint.cost)}
            </p>
          </div>
        )}
      </div>

      {/* legend */}
      <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1 text-[0.6875rem] font-bold text-low">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-0.5 w-4 rounded bg-primary" />
          {mode === 'market' ? 'Market value' : 'Cost basis'}
        </span>
        {mode === 'market' && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block w-4 border-t-2 border-dashed border-low" />
            Cost basis
          </span>
        )}
      </div>
    </div>
  );
}
