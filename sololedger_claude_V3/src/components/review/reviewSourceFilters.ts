import type { SourcePresentation } from '@/lib/sources/sourcePresentation';
import type { Transaction } from '@/types/transaction';

export interface ReviewSourceFilterOption {
  key: string;
  label: string;
  iconId: string | null;
  status: SourcePresentation['status'];
}

export function buildReviewSourceFilterOptions(
  transactions: readonly Transaction[],
  presentations: ReadonlyMap<string, SourcePresentation>
): ReviewSourceFilterOption[] {
  const options = new Map<string, ReviewSourceFilterOption & { presentation: SourcePresentation }>();
  for (const transaction of transactions) {
    const presentation = presentations.get(transaction.id);
    if (!presentation || options.has(presentation.sourceKey)) continue;
    options.set(presentation.sourceKey, {
      key: presentation.sourceKey,
      label: presentation.filterLabel,
      iconId: presentation.iconId,
      status: presentation.status,
      presentation
    });
  }
  const rows = [...options.values()];
  const duplicateLabels = () => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.label, (counts.get(row.label) ?? 0) + 1);
    return counts;
  };
  const qualifiers = [
    (row: typeof rows[number]) => row.presentation.address,
    (row: typeof rows[number]) => row.presentation.sourceKey,
    (row: typeof rows[number]) => row.presentation.accountKey
  ];
  for (const qualifier of qualifiers) {
    const counts = duplicateLabels();
    for (const row of rows) {
      if ((counts.get(row.label) ?? 0) <= 1) continue;
      const exact = qualifier(row);
      if (exact) row.label = `${row.label} · ${exact}`;
    }
  }
  const result: ReviewSourceFilterOption[] = rows.map(({ presentation: _presentation, ...row }) => row);
  return result.sort((left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key));
}

export function transactionMatchesSourceFilter(
  transaction: Transaction,
  filterKey: string,
  presentations: ReadonlyMap<string, SourcePresentation>
): boolean {
  return filterKey === 'all' || presentations.get(transaction.id)?.sourceKey === filterKey;
}
