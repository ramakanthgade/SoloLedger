/**
 * Mockup "Held for" column formatting for the Capital Gains disposals table:
 * 26d → "26 days", 45d → "1m 15d", 60d → "2m", 426d → "1y 2m".
 */
export function formatHoldingPeriod(days: number): string {
  const d = Math.max(0, Math.round(days));
  if (d >= 365) {
    const y = Math.floor(d / 365);
    const m = Math.floor((d % 365) / 30);
    return m > 0 ? `${y}y ${m}m` : `${y}y`;
  }
  if (d >= 30) {
    const m = Math.floor(d / 30);
    const rem = d % 30;
    return rem > 0 ? `${m}m ${rem}d` : `${m}m`;
  }
  return d === 1 ? '1 day' : `${d} days`;
}
