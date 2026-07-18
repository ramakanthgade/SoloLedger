/**
 * DefiLlama reward-token hints (Phase 2).
 *
 * The free, key-less DefiLlama yields API (https://yields.llama.fi/pools)
 * lists, for every tracked yield pool, the `rewardTokens` it pays out. Across
 * all Solana pools that gives a live, community-maintained set of "tokens that
 * are known to be paid out as rewards" — exactly the signal Phase 1 hard-coded
 * for GEOD/DBT, generalized.
 *
 * CONFIDENCE MODEL: a mint appearing here is a *hint*, not proof. USDC can be
 * a pool reward and still arrive as an ordinary transfer. So hints NEVER
 * auto-classify on their own — they drive user-confirmed suggestions that land
 * in the review queue (`needs_review` flag). High-confidence classification
 * stays with the static registry in rewardRegistry.ts.
 *
 * PRIVACY / NETWORK POLICY: fetching is user-gated (AC-A1 — no background
 * network calls in local mode without a user trigger) and carries no user
 * data — the request is a plain GET with no parameters. Results are cached
 * locally for 24 h because the payload is ~10 MB.
 */

/** One Solana reward-token mint that DefiLlama reports as a pool reward. */
export interface LlamaRewardHint {
  /** SPL token mint address. */
  mint: string;
  /** Projects (protocols) whose pools pay this token as a reward, sorted. */
  projects: string[];
  /** A few example pool symbols paying it (for display context), sorted. */
  poolSymbols: string[];
  /** Number of Solana pools paying this token as a reward. */
  poolCount: number;
}

export const DEFILLAMA_POOLS_URL = 'https://yields.llama.fi/pools';

/** localStorage cache key + TTL (24 h — the full payload is ~10 MB). */
export const DEFILLAMA_HINTS_CACHE_KEY = 'sololedger_defillama_reward_hints_v1';
export const DEFILLAMA_HINTS_TTL_MS = 24 * 60 * 60 * 1000;

interface HintsCacheShape {
  fetchedAt: number;
  hints: LlamaRewardHint[];
}

/** A cache layer's decoded contents (mint → hint map + when it was fetched). */
interface CachedHints {
  fetchedAt: number;
  hints: Map<string, LlamaRewardHint>;
}

/**
 * Mints excluded from suggestions even when DefiLlama lists them as rewards.
 * Wrapped SOL and the major stablecoins constantly arrive as ORDINARY
 * transfers (swap proceeds, payments, CEX withdrawals); suggesting them as
 * income would flood the review queue with false positives. Missing the rare
 * genuinely-reward USDC payout is the acceptable trade-off — the user can
 * still classify it per-row.
 */
export const EXCLUDED_REWARD_MINTS: ReadonlySet<string> = new Set([
  'So11111111111111111111111111111111111111112', // Wrapped SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', // USDS (Sky)
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG (Global Dollar)
  'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD', // JUPUSD
  'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', // EURC
  '2zMqyX4AYCk6mgy5UZ2S7zUaLxwERhK5WjqDzkPPbSpW' // TGBP
]);

/** Caps keep transaction notes + the cache readable as DefiLlama grows. */
export const MAX_HINT_PROJECTS = 3;
export const MAX_HINT_POOL_SYMBOLS = 5;

/**
 * Parse the yields.llama.fi/pools payload into a mint → hint map for Solana.
 * Defensive by construction: any malformed entry is skipped, and a payload
 * that doesn't match the expected shape yields an empty map (never throws).
 */
export function parseSolanaRewardHints(payload: unknown): Map<string, LlamaRewardHint> {
  const hints = new Map<string, LlamaRewardHint>();
  if (!payload || typeof payload !== 'object') return hints;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return hints;

  for (const pool of data) {
    if (!pool || typeof pool !== 'object') continue;
    const p = pool as {
      chain?: unknown;
      rewardTokens?: unknown;
      project?: unknown;
      symbol?: unknown;
    };
    if (p.chain !== 'Solana' || !Array.isArray(p.rewardTokens)) continue;
    const project = typeof p.project === 'string' && p.project ? p.project : 'unknown';
    const poolSymbol = typeof p.symbol === 'string' && p.symbol ? p.symbol : null;

    for (const mint of p.rewardTokens) {
      if (typeof mint !== 'string' || mint.length < 32) continue;
      if (EXCLUDED_REWARD_MINTS.has(mint)) continue;

      const existing = hints.get(mint);
      if (existing) {
        existing.poolCount += 1;
        if (!existing.projects.includes(project)) existing.projects.push(project);
        if (poolSymbol && !existing.poolSymbols.includes(poolSymbol)) {
          existing.poolSymbols.push(poolSymbol);
        }
      } else {
        hints.set(mint, {
          mint,
          projects: [project],
          poolSymbols: poolSymbol ? [poolSymbol] : [],
          poolCount: 1
        });
      }
    }
  }

  // Stable ordering for deterministic notes/tests; capped so notes and the
  // localStorage cache stay small as DefiLlama's pool list grows.
  for (const h of hints.values()) {
    h.projects.sort();
    h.projects = h.projects.slice(0, MAX_HINT_PROJECTS);
    h.poolSymbols.sort();
    h.poolSymbols = h.poolSymbols.slice(0, MAX_HINT_POOL_SYMBOLS);
  }
  return hints;
}

// ---- Caching layer (module memory → localStorage → network) ----

let memoryCache: CachedHints | null = null;
let inFlight: Promise<FetchHintsResult> | null = null;

function readStorageCache(): CachedHints | null {
  try {
    const raw = localStorage.getItem(DEFILLAMA_HINTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HintsCacheShape;
    if (!parsed || typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.hints)) {
      return null;
    }
    const hints = new Map<string, LlamaRewardHint>();
    for (const h of parsed.hints) {
      // Validate the full shape, not just `mint`: a corrupted/partial entry
      // with a fresh fetchedAt would otherwise bypass the network and blow up
      // later when consumers assume `projects`/`poolSymbols` are arrays.
      if (
        !h ||
        typeof h.mint !== 'string' ||
        !Array.isArray(h.projects) ||
        !Array.isArray(h.poolSymbols) ||
        typeof h.poolCount !== 'number' ||
        !Number.isFinite(h.poolCount)
      ) {
        continue;
      }
      // Re-apply the exclusion list on restore: a mint excluded AFTER it was
      // cached must not survive for the rest of the TTL.
      if (EXCLUDED_REWARD_MINTS.has(h.mint)) continue;
      hints.set(h.mint, h);
    }
    // If the payload had entries but every one was invalid, treat the cache as
    // missing so the caller refreshes from the network instead of trusting it.
    if (parsed.hints.length > 0 && hints.size === 0) return null;
    return { fetchedAt: parsed.fetchedAt, hints };
  } catch {
    return null;
  }
}

function writeStorageCache(fetchedAt: number, hints: Map<string, LlamaRewardHint>): void {
  try {
    const shape: HintsCacheShape = { fetchedAt, hints: [...hints.values()] };
    localStorage.setItem(DEFILLAMA_HINTS_CACHE_KEY, JSON.stringify(shape));
  } catch {
    // Quota/serialization failures are non-fatal — the memory cache still serves.
  }
}

/** Test hook: drop both cache layers. */
export function clearDefiLlamaHintCache(): void {
  memoryCache = null;
  inFlight = null;
  try {
    localStorage.removeItem(DEFILLAMA_HINTS_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

export interface FetchHintsResult {
  hints: Map<string, LlamaRewardHint>;
  /** True when served from a cache layer rather than the network. */
  fromCache: boolean;
  /** Epoch ms of when the hints were fetched from the network. */
  fetchedAt: number;
}

/**
 * Fetch the Solana reward-token hints, user-gated. Serves the freshest of
 * (in-memory, localStorage < 24 h) before hitting the network; dedupes
 * concurrent calls; on network failure falls back to a STALE cache if one
 * exists, and only throws when there is nothing to fall back to.
 */
export async function fetchSolanaRewardHints(opts?: {
  forceRefresh?: boolean;
}): Promise<FetchHintsResult> {
  const now = Date.now();

  if (!opts?.forceRefresh) {
    if (memoryCache && now - memoryCache.fetchedAt < DEFILLAMA_HINTS_TTL_MS) {
      return { hints: memoryCache.hints, fromCache: true, fetchedAt: memoryCache.fetchedAt };
    }
    const stored = readStorageCache();
    if (stored && now - stored.fetchedAt < DEFILLAMA_HINTS_TTL_MS) {
      memoryCache = stored;
      return { hints: stored.hints, fromCache: true, fetchedAt: stored.fetchedAt };
    }
  }

  if (!inFlight) {
    // The stale-cache fallback lives INSIDE the shared promise so every
    // concurrent awaiter gets identical behavior (fresh → stale → throw).
    inFlight = (async (): Promise<FetchHintsResult> => {
      try {
        const res = await fetch(DEFILLAMA_POOLS_URL, {
          headers: { accept: 'application/json' }
        });
        if (!res.ok) throw new Error(`DefiLlama request failed (HTTP ${res.status})`);
        const payload: unknown = await res.json();
        const hints = parseSolanaRewardHints(payload);
        const fetchedAt = Date.now();
        memoryCache = { fetchedAt, hints };
        writeStorageCache(fetchedAt, hints);
        return { hints, fromCache: false, fetchedAt };
      } catch (err) {
        // Network down / CORS / parse failure: serve a stale cache if we have one.
        const stale = memoryCache ?? readStorageCache();
        if (stale && stale.hints.size > 0) {
          memoryCache = stale;
          return { hints: stale.hints, fromCache: true, fetchedAt: stale.fetchedAt };
        }
        throw err instanceof Error ? err : new Error('DefiLlama request failed');
      } finally {
        inFlight = null;
      }
    })();
  }

  return inFlight;
}
