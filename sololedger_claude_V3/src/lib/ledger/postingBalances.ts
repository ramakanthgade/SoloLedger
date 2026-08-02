import { comparePostings, type DerivedPosting } from './derivedPostings';

export type PostingBalanceKey = string;

export interface PostingBalanceOptions {
  asOf?: number;
  scopeId?: string;
  accountClass?: DerivedPosting['accountClass'];
  metrics?: PostingAggregationMetrics;
}

export interface PostingAggregationMetrics { postingVisits: number }

export function postingBalanceKey(posting: Pick<DerivedPosting, 'accountScopeId' | 'accountClass' | 'assetKey'>): PostingBalanceKey {
  return `${posting.accountScopeId}|${posting.accountClass}|${posting.assetKey}`;
}

function orderedPostings(postings: readonly DerivedPosting[]): readonly DerivedPosting[] {
  for (let index = 1; index < postings.length; index++) {
    if (comparePostings(postings[index - 1], postings[index]) > 0) return [...postings].sort(comparePostings);
  }
  return postings;
}

export function postingBalances(
  postings: readonly DerivedPosting[],
  options: PostingBalanceOptions = {}
): Map<PostingBalanceKey, number> {
  const balances = new Map<PostingBalanceKey, number>();
  const { asOf, scopeId, accountClass, metrics } = options;
  for (const posting of orderedPostings(postings)) {
    if (metrics) metrics.postingVisits += 1;
    if (asOf != null && posting.effectiveAt > asOf) break;
    if (scopeId != null && posting.accountScopeId !== scopeId) continue;
    if (accountClass != null && posting.accountClass !== accountClass) continue;
    const key = postingBalanceKey(posting);
    balances.set(key, posting.role === 'opening_balance'
      ? posting.signedQuantity
      : (balances.get(key) ?? 0) + posting.signedQuantity);
  }
  return balances;
}

export interface RunningBalancePoint {
  postingId: string;
  effectiveAt: number;
  balance: number;
}

export interface RunningBalanceIndex {
  orderedPostingIds: string[];
  byBalanceKey: Map<PostingBalanceKey, RunningBalancePoint[]>;
  postingPosition: Map<string, number>;
}

export function buildRunningBalanceIndex(
  postings: readonly DerivedPosting[],
  metrics?: PostingAggregationMetrics
): RunningBalanceIndex {
  const ordered = orderedPostings(postings);
  const orderedPostingIds: string[] = [];
  const byBalanceKey = new Map<PostingBalanceKey, RunningBalancePoint[]>();
  const postingPosition = new Map<string, number>();
  for (let position = 0; position < ordered.length; position++) {
    if (metrics) metrics.postingVisits += 1;
    const posting = ordered[position];
    const key = postingBalanceKey(posting);
    let points = byBalanceKey.get(key);
    if (points == null) {
      points = [];
      byBalanceKey.set(key, points);
    }
    const balance = posting.role === 'opening_balance'
      ? posting.signedQuantity
      : (points.length === 0 ? 0 : points[points.length - 1].balance) + posting.signedQuantity;
    points.push({ postingId: posting.id, effectiveAt: posting.effectiveAt, balance });
    orderedPostingIds.push(posting.id);
    postingPosition.set(posting.id, position);
  }
  return { orderedPostingIds, byBalanceKey, postingPosition };
}

export type ChartBucket = 'hour' | 'day' | 'week' | 'month' | number;
export interface ChartPrefixPoint { bucketStart: number; balance: number }
export interface ChartPrefixIndex { bucketMs: number; byBalanceKey: Map<PostingBalanceKey, ChartPrefixPoint[]> }

function bucketMilliseconds(bucket: ChartBucket): number {
  if (typeof bucket === 'number') {
    if (!Number.isFinite(bucket) || bucket <= 0) throw new Error('bucket must be positive');
    return bucket;
  }
  return { hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000 }[bucket];
}

export function buildChartPrefixIndex(
  postings: readonly DerivedPosting[],
  bucket: ChartBucket,
  metrics?: PostingAggregationMetrics
): ChartPrefixIndex {
  const bucketMs = bucketMilliseconds(bucket);
  const ordered = orderedPostings(postings);
  const byBalanceKey = new Map<PostingBalanceKey, ChartPrefixPoint[]>();
  const running = new Map<PostingBalanceKey, number>();
  for (const posting of ordered) {
    if (metrics) metrics.postingVisits += 1;
    const key = postingBalanceKey(posting);
    const bucketStart = Math.floor(posting.effectiveAt / bucketMs) * bucketMs;
    const balance = posting.role === 'opening_balance'
      ? posting.signedQuantity
      : (running.get(key) ?? 0) + posting.signedQuantity;
    running.set(key, balance);
    let points = byBalanceKey.get(key);
    if (points == null) {
      points = [];
      byBalanceKey.set(key, points);
    }
    const last = points[points.length - 1];
    if (last?.bucketStart === bucketStart) last.balance = balance;
    else points.push({ bucketStart, balance });
  }
  return { bucketMs, byBalanceKey };
}
