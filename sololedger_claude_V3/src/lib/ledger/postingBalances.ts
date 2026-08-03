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

type PostingKeyCache = Map<
  string,
  Map<DerivedPosting['accountClass'], Map<string, PostingBalanceKey>>
>;

/**
 * Ephemeral snapshot for several synchronous aggregations over the same posting
 * state. It is never cached globally; callers that mutate postings create a new
 * snapshot, while existing public calls continue to inspect their input afresh.
 */
export interface PreparedPostingAggregation {
  readonly source: readonly DerivedPosting[];
  readonly ordered: readonly DerivedPosting[];
  readonly keys: readonly PostingBalanceKey[];
  /** Final no-cutoff balances and labels, grouped for authority consumers. */
  readonly scopes: ReadonlyMap<string, PreparedPostingScopeAggregation>;
  /** First posting per canonical asset, for stable historical display identity. */
  readonly representativeByAsset: ReadonlyMap<string, DerivedPosting>;
  /** Compact chart indexes aligned with `ordered`; avoid per-posting string-map lookups. */
  readonly balanceSlotByPosting: readonly number[];
  readonly assetSlotByPosting: readonly number[];
  readonly assetKeys: readonly string[];
  readonly balanceSlotCount: number;
  readonly balanceSlots: ReadonlyMap<PostingBalanceKey, number>;
  readonly assetSlots: ReadonlyMap<string, number>;
}

export interface PreparedPostingScopeAggregation {
  readonly scopeId: string;
  readonly accountClass: DerivedPosting['accountClass'];
  readonly postingCount: number;
  readonly balances: ReadonlyMap<string, number>;
  readonly assets: ReadonlyMap<string, string>;
}

export function postingScopeAggregationKey(
  scopeId: string,
  accountClass: DerivedPosting['accountClass']
): string {
  return `${scopeId}\u001f${accountClass}`;
}

function cachedPostingBalanceKey(
  posting: DerivedPosting,
  cache: PostingKeyCache
): PostingBalanceKey {
  let byAccountClass = cache.get(posting.assetKey);
  if (byAccountClass == null) {
    byAccountClass = new Map();
    cache.set(posting.assetKey, byAccountClass);
  }
  let byScope = byAccountClass.get(posting.accountClass);
  if (byScope == null) {
    byScope = new Map();
    byAccountClass.set(posting.accountClass, byScope);
  }
  const cached = byScope.get(posting.accountScopeId);
  if (cached != null) return cached;
  const key = postingBalanceKey(posting);
  byScope.set(posting.accountScopeId, key);
  return key;
}

function orderedPostings(postings: readonly DerivedPosting[]): readonly DerivedPosting[] {
  for (let index = 1; index < postings.length; index++) {
    const previous = postings[index - 1];
    const current = postings[index];
    if (
      previous.effectiveAt > current.effectiveAt ||
      (previous.effectiveAt === current.effectiveAt && comparePostings(previous, current) > 0)
    ) return [...postings].sort(comparePostings);
  }
  return postings;
}

export function preparePostingAggregation(
  postings: readonly DerivedPosting[],
  alreadyOrdered = false
): PreparedPostingAggregation {
  const ordered = alreadyOrdered ? postings : orderedPostings(postings);
  const keyCache: PostingKeyCache = new Map();
  const keys = new Array<PostingBalanceKey>(ordered.length);
  const mutableScopes = new Map<string, {
    scopeId: string;
    accountClass: DerivedPosting['accountClass'];
    postingCount: number;
    balances: Map<string, number>;
    assets: Map<string, string>;
  }>();
  const representativeByAsset = new Map<string, DerivedPosting>();
  const balanceSlots = new Map<PostingBalanceKey, number>();
  const assetSlots = new Map<string, number>();
  const balanceSlotByPosting = new Array<number>(ordered.length);
  const assetSlotByPosting = new Array<number>(ordered.length);
  const assetKeys: string[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const posting = ordered[index];
    if (!representativeByAsset.has(posting.assetKey)) {
      representativeByAsset.set(posting.assetKey, posting);
    }
    keys[index] = cachedPostingBalanceKey(posting, keyCache);
    let balanceSlot = balanceSlots.get(keys[index]);
    if (balanceSlot == null) {
      balanceSlot = balanceSlots.size;
      balanceSlots.set(keys[index], balanceSlot);
    }
    balanceSlotByPosting[index] = balanceSlot;
    let assetSlot = assetSlots.get(posting.assetKey);
    if (assetSlot == null) {
      assetSlot = assetSlots.size;
      assetSlots.set(posting.assetKey, assetSlot);
      assetKeys.push(posting.assetKey);
    }
    assetSlotByPosting[index] = assetSlot;
    const scopeKey = postingScopeAggregationKey(posting.accountScopeId, posting.accountClass);
    let scope = mutableScopes.get(scopeKey);
    if (scope == null) {
      scope = {
        scopeId: posting.accountScopeId,
        accountClass: posting.accountClass,
        postingCount: 0,
        balances: new Map(),
        assets: new Map()
      };
      mutableScopes.set(scopeKey, scope);
    }
    scope.postingCount += 1;
    scope.assets.set(posting.assetKey, posting.asset);
    scope.balances.set(
      posting.assetKey,
      posting.role === 'opening_balance'
        ? posting.signedQuantity
        : (scope.balances.get(posting.assetKey) ?? 0) + posting.signedQuantity
    );
  }
  return {
    source: postings, ordered, keys, scopes: mutableScopes, representativeByAsset,
    balanceSlotByPosting, assetSlotByPosting, assetKeys,
    balanceSlotCount: balanceSlots.size, balanceSlots, assetSlots
  };
}

/** Extend an immutable aggregation when callers have proved every new posting is later. */
export function appendPreparedPostingAggregation(
  prepared: PreparedPostingAggregation,
  postings: readonly DerivedPosting[],
  appended: readonly DerivedPosting[]
): PreparedPostingAggregation {
  if (appended.length === 0 || postings.length !== prepared.source.length + appended.length) {
    throw new Error('invalid prepared posting append');
  }
  const previousLast = prepared.ordered[prepared.ordered.length - 1];
  if (previousLast && comparePostings(previousLast, appended[0]) > 0) {
    throw new Error('prepared posting append is not ordered');
  }
  for (let index = 1; index < appended.length; index++) {
    if (comparePostings(appended[index - 1], appended[index]) > 0) {
      throw new Error('prepared posting append is not ordered');
    }
  }

  const keys = [...prepared.keys];
  const scopes = new Map(prepared.scopes);
  const representativeByAsset = new Map(prepared.representativeByAsset);
  const balanceSlots = new Map(prepared.balanceSlots);
  const assetSlots = new Map(prepared.assetSlots);
  const balanceSlotByPosting = [...prepared.balanceSlotByPosting];
  const assetSlotByPosting = [...prepared.assetSlotByPosting];
  const assetKeys = [...prepared.assetKeys];
  for (const posting of appended) {
    const key = postingBalanceKey(posting);
    keys.push(key);
    let balanceSlot = balanceSlots.get(key);
    if (balanceSlot == null) {
      balanceSlot = balanceSlots.size;
      balanceSlots.set(key, balanceSlot);
    }
    balanceSlotByPosting.push(balanceSlot);
    let assetSlot = assetSlots.get(posting.assetKey);
    if (assetSlot == null) {
      assetSlot = assetSlots.size;
      assetSlots.set(posting.assetKey, assetSlot);
      assetKeys.push(posting.assetKey);
    }
    assetSlotByPosting.push(assetSlot);
    if (!representativeByAsset.has(posting.assetKey)) representativeByAsset.set(posting.assetKey, posting);
    const scopeKey = postingScopeAggregationKey(posting.accountScopeId, posting.accountClass);
    const previous = scopes.get(scopeKey);
    const balances = new Map(previous?.balances);
    const assets = new Map(previous?.assets);
    assets.set(posting.assetKey, posting.asset);
    balances.set(posting.assetKey, posting.role === 'opening_balance'
      ? posting.signedQuantity
      : (balances.get(posting.assetKey) ?? 0) + posting.signedQuantity);
    scopes.set(scopeKey, {
      scopeId: posting.accountScopeId,
      accountClass: posting.accountClass,
      postingCount: (previous?.postingCount ?? 0) + 1,
      balances,
      assets
    });
  }
  return {
    source: postings, ordered: postings, keys, scopes, representativeByAsset,
    balanceSlotByPosting, assetSlotByPosting, assetKeys,
    balanceSlotCount: balanceSlots.size, balanceSlots, assetSlots
  };
}

function aggregationSnapshot(
  postings: readonly DerivedPosting[],
  prepared?: PreparedPostingAggregation
): PreparedPostingAggregation {
  if (prepared == null) return preparePostingAggregation(postings);
  if (prepared.source !== postings) throw new Error('prepared posting aggregation source mismatch');
  return prepared;
}

export function postingBalances(
  postings: readonly DerivedPosting[],
  options: PostingBalanceOptions = {},
  prepared?: PreparedPostingAggregation
): Map<PostingBalanceKey, number> {
  const balances = new Map<PostingBalanceKey, number>();
  const snapshot = aggregationSnapshot(postings, prepared);
  const { asOf, scopeId, accountClass, metrics } = options;
  for (let index = 0; index < snapshot.ordered.length; index++) {
    const posting = snapshot.ordered[index];
    if (metrics) metrics.postingVisits += 1;
    if (asOf != null && posting.effectiveAt > asOf) break;
    if (scopeId != null && posting.accountScopeId !== scopeId) continue;
    if (accountClass != null && posting.accountClass !== accountClass) continue;
    const key = snapshot.keys[index];
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
  metrics?: PostingAggregationMetrics,
  prepared?: PreparedPostingAggregation
): RunningBalanceIndex {
  const snapshot = aggregationSnapshot(postings, prepared);
  const ordered = snapshot.ordered;
  const orderedPostingIds: string[] = [];
  const byBalanceKey = new Map<PostingBalanceKey, RunningBalancePoint[]>();
  const postingPosition = new Map<string, number>();
  for (let position = 0; position < ordered.length; position++) {
    if (metrics) metrics.postingVisits += 1;
    const posting = ordered[position];
    const key = snapshot.keys[position];
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
  metrics?: PostingAggregationMetrics,
  prepared?: PreparedPostingAggregation
): ChartPrefixIndex {
  const bucketMs = bucketMilliseconds(bucket);
  const snapshot = aggregationSnapshot(postings, prepared);
  const ordered = snapshot.ordered;
  const byBalanceKey = new Map<PostingBalanceKey, ChartPrefixPoint[]>();
  const running = new Map<PostingBalanceKey, number>();
  for (let index = 0; index < ordered.length; index++) {
    const posting = ordered[index];
    if (metrics) metrics.postingVisits += 1;
    const key = snapshot.keys[index];
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
