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
}

/**
 * Fetch all completed DCA order fills for a wallet from Jupiter's free API.
 * Returns an empty result on network failures (fails gracefully).
 */
export async function fetchJupiterRecurringHistory(
  walletAddress: string
): Promise<JupiterRecurringResult> {
  const empty: JupiterRecurringResult = { orders: [], fillsByTxId: new Map() };
  try {
    const url =
      `${JUPITER_RECURRING}/getRecurringOrders` +
      `?user=${walletAddress}&orderStatus=history&recurringType=time&page=1`;
    // Jupiter's free API is called directly — no key, no SaaS proxy.
    recordNetworkActivity(resolveMode(false));
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return empty;
    const data = await res.json();

    // The API may return orders in different shapes — handle both flat and nested.
    const rawOrders: any[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.orders)
        ? data.orders
        : Array.isArray(data?.data)
          ? data.data
          : [];

    const orders: JupiterRecurringOrder[] = rawOrders.map((o: any) => {
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

    return { orders, fillsByTxId };
  } catch {
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
