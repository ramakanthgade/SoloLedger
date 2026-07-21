/**
 * Jupiter Recurring (DCA) API client — free, no API key required.
 *
 * Docs: https://developers.jup.ag/docs/api-reference/recurring/get-recurring-orders
 * Endpoint: GET https://api.jup.ag/recurring/v1/getRecurringOrders
 *
 * This API returns the full fill history for a wallet's DCA orders, including:
 *   - The exact amount of input token (e.g. DBT) sold per fill
 *   - The exact amount of output token (e.g. USDC) received per fill
 *   - The transaction signature for each fill (matches our sourceRef)
 *
 * This is the authoritative data source for Jupiter DCA tax calculations.
 * It is completely free — no Jupiter subscription needed.
 */

import { recordNetworkActivity, resolveMode } from '@/lib/networkActivity';

const JUPITER_RECURRING = 'https://api.jup.ag/recurring/v1';

/** One executed fill in a DCA order. */
export interface JupiterFill {
  /** Solana transaction signature — matches Transaction.sourceRef in the DB. */
  txId: string;
  /** Exact input token amount sold for this fill (raw integer, needs decimals applied). */
  rawInputAmount: string;
  /** Exact output token amount received (raw integer, needs decimals applied). */
  rawOutputAmount: string;
  /** Human-readable input amount. */
  inputAmount: number;
  /** Human-readable output amount. */
  outputAmount: number;
  /** ISO timestamp when the fill was confirmed. */
  confirmedAt: string;
  action: string;
}

/** One DCA order (may have multiple fills). */
export interface JupiterRecurringOrder {
  /** The DCA vault/account address. */
  orderKey: string;
  inputMint: string;
  outputMint: string;
  /** Total input deposited (raw). */
  inDeposited: string;
  /** Total input left (raw). Closed orders have 0. */
  inLeft: string;
  fills: JupiterFill[];
}

export interface JupiterRecurringResult {
  orders: JupiterRecurringOrder[];
  /** txId → fill mapping for fast lookup by transaction signature. */
  fillsByTxId: Map<string, { order: JupiterRecurringOrder; fill: JupiterFill }>;
  /**
   * True when Jupiter's API answered at least one request (HTTP ok), so an
   * empty `orders` list is a CONFIRMED "this wallet has no DCA orders".
   * False means network/5xx — the empty result says nothing and callers must
   * NOT treat it as confirmation (fail open: skip and retry later).
   */
  reachable: boolean;
}

/**
 * Fetch all DCA order fills for a wallet from Jupiter's free API — both
 * completed (`history`) and in-progress (`active`) orders, so an ongoing
 * order dripping new fills still verifies. On network failure returns an
 * empty result with `reachable: false` (never a fake "confirmed empty").
 */
export async function fetchJupiterRecurringHistory(
  walletAddress: string
): Promise<JupiterRecurringResult> {
  const empty: JupiterRecurringResult = { orders: [], fillsByTxId: new Map(), reachable: false };
  const rawOrders: any[] = [];
  let reachable = false;

  for (const orderStatus of ['history', 'active'] as const) {
    try {
      const url =
        `${JUPITER_RECURRING}/getRecurringOrders` +
        `?user=${walletAddress}&orderStatus=${orderStatus}&recurringType=time&page=1`;
      // Jupiter's free API is called directly — no key, no SaaS proxy.
      recordNetworkActivity(resolveMode(false));
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      reachable = true;
      // eslint-disable-next-line no-await-in-loop
      const data = await res.json();
      const list: any[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.orders)
          ? data.orders
          : Array.isArray(data?.data)
            ? data.data
            : [];
      rawOrders.push(...list);
    } catch {
      // This status bucket failed — the other one may still succeed.
    }
  }

  if (!reachable) return empty;

  try {
    // Deduplicate orders seen in both buckets (an order closing between the
    // two calls could appear twice) before mapping.
    const seen = new Set<string>();
    const uniqueOrders = rawOrders.filter((o: any) => {
      const key = String(o?.orderKey ?? o?.id ?? o?.dcaKey ?? '');
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const orders: JupiterRecurringOrder[] = uniqueOrders.map((o: any) => {
      // Fills may be nested or returned as top-level trades array
      const rawFills: any[] = o.fills ?? o.trades ?? o.tradeHistory ?? [];
      const fills: JupiterFill[] = rawFills.map((f: any) => ({
        txId: f.txId ?? f.transactionId ?? f.signature ?? '',
        rawInputAmount: String(f.rawInputAmount ?? f.rawInput ?? '0'),
        rawOutputAmount: String(f.rawOutputAmount ?? f.rawOutput ?? '0'),
        inputAmount: Number(f.inputAmount ?? f.input ?? 0),
        outputAmount: Number(f.outputAmount ?? f.output ?? 0),
        confirmedAt: f.confirmedAt ?? f.timestamp ?? '',
        action: f.action ?? 'filled'
      }));
      return {
        orderKey: o.orderKey ?? o.id ?? o.dcaKey ?? '',
        inputMint: o.inputMint ?? '',
        outputMint: o.outputMint ?? '',
        inDeposited: String(o.inDeposited ?? o.totalInput ?? '0'),
        inLeft: String(o.inLeft ?? '0'),
        fills
      };
    });

    const fillsByTxId = new Map<string, { order: JupiterRecurringOrder; fill: JupiterFill }>();
    for (const order of orders) {
      for (const fill of order.fills) {
        if (fill.txId) fillsByTxId.set(fill.txId, { order, fill });
      }
    }

    return { orders, fillsByTxId, reachable: true };
  } catch {
    // Malformed payload — the API WAS reached, but we can't trust the parse.
    // Report unreachable so callers fail open instead of acting on garbage.
    return empty;
  }
}

/** Resolve token decimals for known Solana mints (avoids extra RPC calls). */
const KNOWN_DECIMALS: Record<string, number> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6, // USDT
  So11111111111111111111111111111111111111112: 9    // SOL
};

export function toHumanAmount(rawAmount: string, mint: string, fallbackDecimals = 9): number {
  const dec = KNOWN_DECIMALS[mint] ?? fallbackDecimals;
  return Number(BigInt(rawAmount || '0')) / 10 ** dec;
}
