/** Parse Review's manual total-market-value field without treating blank text as zero. */
export function parseManualMarketValue(input: string): number | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
