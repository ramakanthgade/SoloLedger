const DAY_MS = 86_400_000;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface ChartTimelineTick {
  frac: number;
  label: string;
}

/** Calendar-aware chart domain ticks; empty months remain part of the selected range. */
export function chartTimelineTicks(
  start: number,
  end: number,
  jurisdiction: 'IN' | 'US' | 'CA' | 'AE'
): ChartTimelineTick[] {
  const span = end - start;
  if (span <= 0) return [];
  if (span <= 45 * DAY_MS) {
    const step = 7 * DAY_MS;
    const first = Math.ceil(start / step) * step;
    const ticks: ChartTimelineTick[] = [];
    for (let t = first; t < end; t += step) {
      const india = jurisdiction === 'IN';
      const date = new Date(india ? t + IST_OFFSET_MS : t);
      const monthIndex = india ? date.getUTCMonth() : date.getMonth();
      const day = india ? date.getUTCDate() : date.getDate();
      ticks.push({
        frac: (t - start) / span,
        label: `${MONTHS_SHORT[monthIndex]} ${day}`
      });
    }
    return ticks;
  }

  const ticks: ChartTimelineTick[] = [];
  const india = jurisdiction === 'IN';
  const cursor = new Date(india ? start + IST_OFFSET_MS : start);
  if (india) {
    cursor.setUTCDate(1);
    cursor.setUTCHours(0, 0, 0, 0);
    if (cursor.getTime() - IST_OFFSET_MS < start) cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  } else {
    cursor.setDate(1);
    cursor.setHours(0, 0, 0, 0);
    if (cursor.getTime() < start) cursor.setMonth(cursor.getMonth() + 1);
  }
  const withYear = span > 400 * DAY_MS;
  let t = india ? cursor.getTime() - IST_OFFSET_MS : cursor.getTime();
  while (t <= end && ticks.length < 12) {
    const monthIndex = india ? cursor.getUTCMonth() : cursor.getMonth();
    const year = india ? cursor.getUTCFullYear() : cursor.getFullYear();
    ticks.push({
      frac: (t - start) / span,
      label: withYear ? `${MONTHS_SHORT[monthIndex]} '${String(year).slice(-2)}` : MONTHS_SHORT[monthIndex]
    });
    if (india) cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setMonth(cursor.getMonth() + 1);
    t = india ? cursor.getTime() - IST_OFFSET_MS : cursor.getTime();
  }
  return ticks;
}
