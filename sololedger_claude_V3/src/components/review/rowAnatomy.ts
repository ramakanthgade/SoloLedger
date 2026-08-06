/**
 * Pure row-anatomy + plain-English summary helpers for the Transactions
 * ledger (the renamed Review tab). Extracted from ReviewTab.tsx so the
 * per-type flow model (sent leg → received leg) and the summary sentences are
 * unit-testable without rendering the tab — a full ReviewTab render never
 * settles under jsdom (see ReviewTab.detectSwaps.test.ts).
 *
 * Honesty rules locked with the design:
 *  - a leg is only produced from data the row actually carries — amounts are
 *    never invented (unknown quantity → `amount: undefined`, rendered "—"),
 *    and single-leg rows (transfers, fees, income) stay single-leg;
 *  - a resolved wallet NAME always beats the raw address; the shortened
 *    address is the fallback for unknown wallets only.
 */
import type { Transaction, TxType } from '@/types/transaction';
import { formatCompactAmount, formatCurrency } from '@/lib/utils';

const DEFAULT_TYPE_LABEL: Record<TxType, string> = {
  buy: 'Buy',
  sell: 'Sell',
  trade: 'Swap',
  transfer_in: 'Receive',
  transfer_out: 'Send',
  income: 'Income',
  gift_sent: 'Gift sent',
  gift_received: 'Gift received',
  fee: 'Fee',
  nft_mint: 'NFT mint',
  nft_buy: 'NFT buy',
  nft_sell: 'NFT sell',
  defi_deposit: 'DeFi deposit',
  defi_withdraw: 'DeFi withdraw',
  other: 'Other'
};

/** Display-only classification. Parser type/category and tax treatment stay unchanged. */
export function reviewTypeLabel(t: Pick<Transaction, 'type' | 'category'>): string {
  if (t.category === 'options_premium' && (t.type === 'fee' || t.type === 'income')) return 'Options premium';
  return DEFAULT_TYPE_LABEL[t.type];
}

/** Shorten a long address/hash for display: 0x1234…abcd. */
export function truncateAddress(addr?: string): string {
  if (!addr) return '—';
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Resolve a wallet address to its Connections label, when known. */
export type WalletNameResolver = (address: string) => string | undefined;

export interface FlowGain {
  kind: 'gain' | 'loss';
  /** Absolute value, currency-formatted (the sign comes from `kind`). */
  formatted: string;
}

export interface RowLeg {
  kind: 'asset' | 'fiat' | 'endpoint';
  /** Principal is `Transaction.asset`; counter is consideration/endpoint context. */
  role: 'principal' | 'counter';
  /** asset legs: resolved display symbol (also drives the coin logo). */
  symbol?: string;
  /** asset/fiat legs: quantity (asset units / fiat amount). Undefined = unknown. */
  amount?: number;
  /** fiat legs: currency code (`fiatCurrency`). */
  currency?: string;
  /** endpoint legs: wallet NAME when resolved, else the shortened address. */
  label?: string;
  /** endpoint legs: the full address (tooltip / copy source). */
  title?: string;
  /** endpoint legs: true when `label` is a resolved wallet name. */
  isName?: boolean;
  /** Direction sign for asset legs (+ value in, − value out). */
  sign?: '+' | '−';
  /** Small line beneath the leg: `cost ₹X` under the sent side of a disposal,
   *  `≈ ₹V` under the received side of a priced row. */
  subline?: string;
  /** Realized gain/loss shown beneath the received leg of a priced disposal. */
  gain?: FlowGain;
}

export interface RowFlow {
  sent: RowLeg | null;
  received: RowLeg | null;
}

export interface FlowCtx {
  assetLabel: string;
  counterLabel?: string | null;
  fromAddr?: string;
  toAddr?: string;
  resolveWallet?: WalletNameResolver;
  /** Priced disposal for this row (pass null when unpriced / not a disposal). */
  disposal?: { costBasis: number; gain: number } | null;
}

function endpointLeg(addr: string, resolveWallet?: WalletNameResolver): RowLeg {
  const name = resolveWallet?.(addr);
  return { kind: 'endpoint', role: 'counter', label: name ?? truncateAddress(addr), title: addr, isName: name != null };
}

/**
 * The middle-of-row flow: what left → what arrived, per transaction type.
 * Disposal rows (sell/trade/nft_sell) carry cost basis under the sent leg and
 * the realized gain/loss under the received leg; transfers pair their asset
 * leg with the counterparty endpoint when one was recorded.
 */
export function txFlow(t: Transaction, ctx: FlowCtx): RowFlow {
  const { assetLabel, counterLabel, fromAddr, toAddr, resolveWallet, disposal } = ctx;
  const gain: FlowGain | undefined = disposal
    ? { kind: disposal.gain >= 0 ? 'gain' : 'loss', formatted: formatCurrency(Math.abs(disposal.gain), t.fiatCurrency) }
    : undefined;
  // Honesty: a disposal whose amount matched no lots has costBasis 0 — that is
  // UNKNOWN, not zero, so the sub-line reads "cost —", never an invented
  // "cost ₹0.00".
  const costSubline = disposal
    ? disposal.costBasis > 0
      ? `cost ${formatCurrency(disposal.costBasis, t.fiatCurrency)}`
      : 'cost —'
    : undefined;
  const valueSubline = t.fiatValue != null ? `≈ ${formatCurrency(t.fiatValue, t.fiatCurrency)}` : undefined;
  const assetLeg = (sign?: '+' | '−', subline?: string): RowLeg => ({
    kind: 'asset',
    role: 'principal',
    symbol: assetLabel,
    amount: t.amount,
    sign,
    subline
  });
  const fiatLeg = (legGain?: FlowGain): RowLeg => ({
    kind: 'fiat',
    role: 'counter',
    amount: t.fiatValue,
    currency: t.fiatCurrency,
    gain: legGain
  });
  const fromEndpoint = fromAddr ? endpointLeg(fromAddr, resolveWallet) : null;
  const toEndpoint = toAddr ? endpointLeg(toAddr, resolveWallet) : null;

  switch (t.type) {
    case 'trade':
      return {
        sent: assetLeg('−', costSubline),
        // A trade without a recorded counter-asset stays a single honest leg.
        received: t.counterAsset
          ? { kind: 'asset', role: 'counter', symbol: counterLabel ?? t.counterAsset, amount: t.counterAmount, sign: '+', subline: valueSubline, gain }
          : null
      };
    case 'sell':
    case 'nft_sell':
      // Crypto-to-crypto sell (Sold LPT → USDT): show the counter-asset leg,
      // not a fiat leg — the ₹ value rides as a subline. Fiat-currency sells
      // (no counterAsset) keep the fiat leg. This matches Koinly, which keeps
      // the original pair and shows the fiat equivalent beside it.
      return {
        sent: assetLeg('−', costSubline),
        received: t.counterAsset
          ? { kind: 'asset', role: 'counter', symbol: counterLabel ?? t.counterAsset, amount: t.counterAmount, sign: '+', subline: valueSubline, gain }
          : fiatLeg(gain)
      };
    case 'buy':
    case 'nft_buy':
      return {
        sent: t.counterAsset
          ? { kind: 'asset', role: 'counter', symbol: counterLabel ?? t.counterAsset, amount: t.counterAmount, sign: '−', subline: valueSubline }
          : fiatLeg(),
        received: assetLeg('+')
      };
    case 'transfer_in':
    case 'gift_received':
      return { sent: fromEndpoint, received: assetLeg('+', valueSubline) };
    case 'transfer_out':
    case 'gift_sent':
      return { sent: assetLeg('−', valueSubline), received: toEndpoint };
    case 'income':
    case 'nft_mint':
    case 'defi_withdraw':
      return { sent: null, received: assetLeg('+', valueSubline) };
    case 'fee':
    case 'defi_deposit':
      return { sent: assetLeg('−', valueSubline), received: null };
    default:
      return { sent: null, received: assetLeg(undefined, valueSubline) };
  }
}

/**
 * Which side of the From/To facts is the user's own account at the source —
 * shown as the source brand (exchange/wallet logo + name) when no wallet
 * address was recorded for that side.
 */
export const OWN_ACCOUNT_SIDE: Record<TxType, 'from' | 'to' | 'both'> = {
  buy: 'to',
  sell: 'from',
  trade: 'both',
  transfer_in: 'to',
  transfer_out: 'from',
  income: 'to',
  gift_sent: 'from',
  gift_received: 'to',
  fee: 'from',
  nft_mint: 'to',
  nft_buy: 'to',
  nft_sell: 'from',
  defi_deposit: 'from',
  defi_withdraw: 'to',
  other: 'both'
};

export interface SummaryCtx {
  assetLabel: string;
  counterLabel?: string | null;
  sourceLabel: string;
  /** Display label for the row's type (only used by the generic fallback). */
  typeLabel: string;
  resolveWallet?: WalletNameResolver;
  fromAddr?: string;
  toAddr?: string;
  /** Priced disposal for this row (pass null when unpriced / not a disposal). */
  disposal?: { costBasis: number; gain: number } | null;
}

export interface TxSummary {
  /** The sentence without its trailing period — the gain/loss tail (when
   *  present) is appended after an em dash by the renderer. */
  lead: string;
  tail?: FlowGain;
}

/** "on Binance" for brands/chains; "via manual entry" for non-brand sources. */
function sourcePhrase(sourceLabel: string): string {
  const lower = sourceLabel.toLowerCase();
  if (lower === 'manual entry' || lower === 'csv import') return `via ${lower}`;
  return `on ${sourceLabel}`;
}

/** "Ledger" → "Ledger wallet"; "My Ledger wallet" stays as-is. */
function walletPlace(name: string): string {
  return /wallet/i.test(name) ? name : `${name} wallet`;
}

/** "in Ledger wallet" for a named wallet, "to 0x1234…abcd" for a raw address. */
function placePhrase(
  addr: string,
  resolveWallet: WalletNameResolver | undefined,
  prepName: string,
  prepAddr: string
): string {
  const name = resolveWallet?.(addr);
  return name ? `${prepName} ${walletPlace(name)}` : `${prepAddr} ${truncateAddress(addr)}`;
}

/**
 * The plain-English one-liner heading the Details panel, per type:
 * "You sold 0.2 BTC for $12,000.00 on Binance" (+ a gain/loss tail),
 * "You received 0.5 ETH in Ledger wallet", …
 */
export function buildTxSummary(t: Transaction, ctx: SummaryCtx): TxSummary {
  const { assetLabel, counterLabel, sourceLabel, resolveWallet, fromAddr, toAddr, disposal } = ctx;
  const amt = `${formatCompactAmount(t.amount)} ${assetLabel}`;
  const fiat = t.fiatValue != null ? formatCurrency(t.fiatValue, t.fiatCurrency) : null;
  const src = sourcePhrase(sourceLabel);
  const tail: FlowGain | undefined = disposal
    ? { kind: disposal.gain >= 0 ? 'gain' : 'loss', formatted: formatCurrency(Math.abs(disposal.gain), t.fiatCurrency) }
    : undefined;
  if (t.category === 'options_premium' && (t.type === 'fee' || t.type === 'income')) {
    return t.type === 'income'
      ? { lead: `You received an Options premium of ${amt}${fiat ? ` worth ${fiat}` : ''} ${src}` }
      : { lead: `You paid an Options premium of ${amt}${fiat ? ` worth ${fiat}` : ''} ${src}` };
  }
  switch (t.type) {
    case 'buy': {
      // Crypto-to-crypto buy (Bought LPT with USDT): keep the original pair,
      // show the fiat equivalent beside. Fiat buys keep "for ₹X".
      if (t.counterAsset) {
        const paid = `${t.counterAmount != null ? `${formatCompactAmount(t.counterAmount)} ` : ''}${counterLabel ?? t.counterAsset}`;
        return { lead: `You bought ${amt} for ${paid}${fiat ? ` (≈ ${fiat})` : ''} ${src}` };
      }
      return { lead: `You bought ${amt}${fiat ? ` for ${fiat}` : ''} ${src}` };
    }
    case 'sell': {
      if (t.counterAsset) {
        const got = `${t.counterAmount != null ? `${formatCompactAmount(t.counterAmount)} ` : ''}${counterLabel ?? t.counterAsset}`;
        return { lead: `You sold ${amt} for ${got}${fiat ? ` (≈ ${fiat})` : ''} ${src}`, tail };
      }
      return { lead: `You sold ${amt}${fiat ? ` for ${fiat}` : ''} ${src}`, tail };
    }
    case 'trade': {
      const counter = `${t.counterAmount != null ? `${formatCompactAmount(t.counterAmount)} ` : ''}${counterLabel ?? t.counterAsset ?? '?'}`;
      return { lead: `You swapped ${amt} for ${counter} ${src}`, tail };
    }
    case 'transfer_in':
      return {
        lead: toAddr
          ? `You received ${amt} ${placePhrase(toAddr, resolveWallet, 'in', 'to')}`
          : `You received ${amt} — imported from ${sourceLabel}`
      };
    case 'transfer_out': {
      const parts = [`You sent ${amt}`];
      if (fromAddr) parts.push(placePhrase(fromAddr, resolveWallet, 'from', 'from'));
      if (toAddr) parts.push(placePhrase(toAddr, resolveWallet, 'to', 'to'));
      if (!fromAddr && !toAddr) parts.push(src);
      return { lead: parts.join(' ') };
    }
    case 'income':
      return { lead: `You received ${amt} as income${fiat ? ` worth ${fiat}` : ''} ${src}` };
    case 'fee':
      return {
        lead: `You paid ${amt} as a network fee${fromAddr ? ` ${placePhrase(fromAddr, resolveWallet, 'from', 'from')}` : ` ${src}`}`
      };
    case 'gift_sent':
      return { lead: `You sent ${amt} as a gift${toAddr ? ` ${placePhrase(toAddr, resolveWallet, 'to', 'to')}` : ''}` };
    case 'gift_received':
      return { lead: `You received ${amt} as a gift${fromAddr ? ` ${placePhrase(fromAddr, resolveWallet, 'from', 'from')}` : ''}` };
    case 'nft_mint':
      return { lead: `You minted ${amt} ${src}` };
    case 'nft_buy':
      return { lead: `You bought ${amt} (NFT)${fiat ? ` for ${fiat}` : ''} ${src}` };
    case 'nft_sell':
      return { lead: `You sold ${amt} (NFT)${fiat ? ` for ${fiat}` : ''} ${src}`, tail };
    case 'defi_deposit':
      return { lead: `You deposited ${amt} into DeFi ${src}` };
    case 'defi_withdraw':
      return { lead: `You withdrew ${amt} from DeFi ${src}` };
    default:
      return { lead: `${ctx.typeLabel}: ${amt}${fiat ? ` worth ${fiat}` : ''} ${src}` };
  }
}
