import type { Transaction, TxType } from '@/types/transaction';
import { makeId, normalizeFiatMagnitude, safeNumber, safeTimestamp, contentHashRef } from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';
import { headerMap, col } from './headerMap';
import { normalizeChain, isRealTxHash, isValidTxHashForChain } from './explorer';

/** User-defined mapping from their CSV's headers to our fields, used when
 * auto-detection fails and the person manually maps columns in the UI. */
export interface ColumnMapping {
  timestamp: string;
  type: string;
  asset: string;
  amount: string;
  /** Total fiat paid/received (e.g. Binance "Total" column) — preferred over price×qty */
  totalValue?: string;
  /** Price per unit — used with amount when totalValue column is absent */
  pricePerUnit?: string;
  fiatValue?: string;
  fiatCurrency?: string;
  feeAmount?: string;
  feeAsset?: string;
  notes?: string;
  /** Chain/Network column (e.g. Binance "Network": ETH/SOL/ADA). */
  network?: string;
  /** Real on-chain tx hash column (e.g. "TXID" / "TX ID" / "Tx Hash"). */
  txHash?: string;
  /** Clearly-named destination-address column (To / Destination). */
  toAddress?: string;
  /** Clearly-named source-address column (From / Source). */
  fromAddress?: string;
  /** Ambiguous single "Address" column (used only when no clear to/from). */
  address?: string;
  typeValueMap: Record<string, TxType>;
  /** When asset column holds pairs like SOLUSDT, extract base asset automatically */
  assetIsTradingPair?: boolean;
}

export const DEFAULT_TYPE_VALUE_MAP: Record<string, TxType> = {
  buy: 'buy',
  sell: 'sell',
  b: 'buy',
  s: 'sell',
  'transaction buy': 'buy',
  'transaction sold': 'sell',
  deposit: 'transfer_in',
  deposits: 'transfer_in',
  withdraw: 'transfer_out',
  withdrawal: 'transfer_out',
  withdrawals: 'transfer_out',
  // Binance exports the withdrawal Side as the misspelled "Withdrawl".
  withdrawl: 'transfer_out',
  withdrawls: 'transfer_out',
  transfer: 'transfer_in',
  income: 'income',
  staking: 'income',
  airdrop: 'income',
  fee: 'fee',
  crypto_purchase: 'buy',
  crypto_sale: 'sell',
  crypto_deposit: 'transfer_in',
  crypto_withdrawal: 'transfer_out',
  crypto_earn_interest: 'income',
  staking_reward: 'income',
  crypto_exchange: 'trade',
  reimbursement: 'income',
  cashback: 'income',
  interest: 'income',
  dividend: 'income',
  bonus: 'income',
  distribution: 'income',
  reward: 'income',
  referral: 'income',
  credit: 'transfer_in',
  debit: 'transfer_out',
  repayment: 'transfer_out',
  swap: 'trade',
  market: 'trade',
  limit_buy: 'buy',
  limit_sell: 'sell',
  market_buy: 'buy',
  market_sell: 'sell',
  'ach deposit': 'transfer_in',
  'ach withdrawal': 'transfer_out',
  payment: 'transfer_out',
  'bitcoin deposit': 'transfer_in',
  'bitcoin withdrawal': 'transfer_out'
};

/**
 * Resolve a raw type cell to a `TxType`. Exact map lookup first, then a
 * conservative substring fallback for transfer variants only (so future
 * misspellings like "Withdrawl" / "Withdrew" are non-fatal). No broad buy/sell
 * substring rules — those are too ambiguous to guess.
 */
export function resolveTxType(
  rawType: string,
  map: Record<string, TxType>
): TxType | undefined {
  const key = (rawType || '').trim().toLowerCase();
  if (!key) return undefined;
  const exact = map[key];
  if (exact) return exact;
  if (key.includes('withdraw')) return 'transfer_out';
  if (key.includes('deposit')) return 'transfer_in';
  return undefined;
}

/**
 * Infer the optional Network / TxHash / Address column families from a header
 * set, reusing the shared `headerMap`/`col` helpers. Applied at the top of
 * `parseWithMapping` so the deterministic, AI-mapped, AND manual paths all
 * auto-detect these columns without extending the AI schema or the manual form.
 *
 * `address` (ambiguous) is only returned when NEITHER clearly-named to/from is
 * present — a single "Address" column can't tell us direction on its own.
 */
export function inferOptionalColumns(
  headers: string[]
): Pick<ColumnMapping, 'network' | 'txHash' | 'toAddress' | 'fromAddress' | 'address'> {
  const map = headerMap(headers);
  const toAddress = col(map, 'toaddress', 'to', 'destination');
  const fromAddress = col(map, 'fromaddress', 'from', 'source');
  return {
    network: col(map, 'network', 'chain'),
    txHash: col(map, 'txid', 'txhash', 'transactionhash', 'transactionid', 'hash'),
    toAddress,
    fromAddress,
    address: !toAddress && !fromAddress ? col(map, 'address') : undefined
  };
}

export function guessTypeValueMap(distinctValues: string[]): Record<string, TxType> {
  const map: Record<string, TxType> = {};
  for (const val of distinctValues) {
    const key = val.trim().toLowerCase();
    if (DEFAULT_TYPE_VALUE_MAP[key]) map[key] = DEFAULT_TYPE_VALUE_MAP[key];
  }
  return map;
}

function resolveFiat(
  row: Record<string, string>,
  mapping: ColumnMapping,
  quote?: string
): { fiatValue?: number; fiatCurrency: string } {
  const explicit = mapping.fiatValue ? Math.abs(safeNumber(row[mapping.fiatValue])) : 0;
  if (explicit > 0) {
    const cur =
      (mapping.fiatCurrency && row[mapping.fiatCurrency]?.trim().toUpperCase()) ||
      quoteToFiatCurrency(quote) ||
      'USD';
    return { fiatValue: explicit, fiatCurrency: cur };
  }

  const total = mapping.totalValue ? Math.abs(safeNumber(row[mapping.totalValue])) : 0;
  if (total > 0) {
    return { fiatValue: total, fiatCurrency: quoteToFiatCurrency(quote) ?? 'USD' };
  }

  const qty = Math.abs(safeNumber(row[mapping.amount]));
  const price = mapping.pricePerUnit ? safeNumber(row[mapping.pricePerUnit]) : 0;
  if (price > 0 && qty > 0) {
    return { fiatValue: price * qty, fiatCurrency: quoteToFiatCurrency(quote) ?? 'USD' };
  }

  return { fiatCurrency: quoteToFiatCurrency(quote) ?? 'USD' };
}

export function parseWithMapping(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
  reportingCurrency = 'USD'
) {
  const transactions: Transaction[] = [];
  const warnings: string[] = [];
  let skippedRows = 0;

  // Auto-detect optional Network / TxHash / Address columns from the file
  // headers for any field the caller didn't set. This makes the deterministic,
  // AI-mapped, and manual paths all populate chain/txHash/address in one place.
  const inferred = rows.length > 0 ? inferOptionalColumns(Object.keys(rows[0])) : undefined;
  const networkCol = mapping.network ?? inferred?.network;
  const txHashCol = mapping.txHash ?? inferred?.txHash;
  const toAddressCol = mapping.toAddress ?? inferred?.toAddress;
  const fromAddressCol = mapping.fromAddress ?? inferred?.fromAddress;
  // Ambiguous single address only when there is no clearly-named to/from.
  const hasClearlyNamed = Boolean(toAddressCol || fromAddressCol);
  const addressCol = hasClearlyNamed ? undefined : mapping.address ?? inferred?.address;

  // True once we actually use the ambiguous single-address column (so Task 4
  // knows this batch's orientation is a best-effort "assume To" guess).
  let addressColumnAmbiguous = false;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rawType = (row[mapping.type] || '').trim();
    const mapped = resolveTxType(rawType, mapping.typeValueMap);
    const timestamp = safeTimestamp(row[mapping.timestamp]);
    const assetRaw = (row[mapping.asset] || '').trim();
    const { base, quote } = mapping.assetIsTradingPair !== false
      ? parseTradingPair(assetRaw)
      : { base: assetRaw.toUpperCase(), quote: undefined };
    const amount = Math.abs(safeNumber(row[mapping.amount]));

    if (!mapped || !base || !Number.isFinite(timestamp) || amount === 0) {
      skippedRows += 1;
      continue;
    }

    const { fiatValue, fiatCurrency } = resolveFiat(row, mapping, quote);
    const feeAmount = mapping.feeAmount ? Math.abs(safeNumber(row[mapping.feeAmount])) : undefined;
    const feeAsset = mapping.feeAsset ? (row[mapping.feeAsset] || '').trim().toUpperCase() : undefined;

    const chain = networkCol ? normalizeChain(row[networkCol]) : undefined;
    const rawTxHash = txHashCol ? (row[txHashCol] || '').trim() : '';
    // Store txHash only when it's a real ref AND matches the row chain's hash
    // shape, so a truncated/internal value (e.g. 0xdeadbeef on ethereum) never
    // becomes a broken explorer link. When chain is unknown we can't validate a
    // shape, so we skip — no chain means no linkable explorer anyway.
    const txHash =
      rawTxHash && isRealTxHash(rawTxHash) && isValidTxHashForChain(chain, rawTxHash)
        ? rawTxHash
        : undefined;

    // Address orientation. `txFromToAddresses` semantics are ASYMMETRIC:
    //   transfer_in : To = walletAddress, From = counterpartyAddress
    //   transfer_out: To = counterpartyAddress, From = walletAddress
    let walletAddress: string | undefined;
    let counterpartyAddress: string | undefined;
    const toVal = toAddressCol ? (row[toAddressCol] || '').trim() || undefined : undefined;
    const fromVal = fromAddressCol ? (row[fromAddressCol] || '').trim() || undefined : undefined;
    if (hasClearlyNamed) {
      if (mapped === 'transfer_in') {
        walletAddress = toVal;
        counterpartyAddress = fromVal;
      } else if (mapped === 'transfer_out') {
        counterpartyAddress = toVal;
        walletAddress = fromVal;
      }
    } else if (addressCol) {
      const addrVal = (row[addressCol] || '').trim() || undefined;
      if (addrVal) {
        // Single ambiguous Address → assume "To".
        if (mapped === 'transfer_in') {
          walletAddress = addrVal;
        } else if (mapped === 'transfer_out') {
          counterpartyAddress = addrVal;
        }
        if (mapped === 'transfer_in' || mapped === 'transfer_out') {
          addressColumnAmbiguous = true;
        }
      }
    }

    transactions.push({
      id: makeId('gen'),
      timestamp,
      type: mapped,
      asset: base,
      amount,
      counterAsset: quote,
      fiatCurrency: fiatCurrency || reportingCurrency,
      fiatValue: normalizeFiatMagnitude(fiatValue),
      feeAmount: feeAmount && feeAmount > 0 ? feeAmount : undefined,
      feeAsset: feeAsset || undefined,
      source: 'manual_mapping',
      // Content-addressed ref (stable across re-imports) instead of a positional
      // `row:<i>` that shifts when rows are reordered/filtered. Lets the dedup
      // layer recognise a re-imported manual/AI row as the same transaction.
      sourceRef: contentHashRef({
        timestamp,
        type: mapped,
        asset: base,
        amount,
        counterAsset: quote,
        counterAmount: normalizeFiatMagnitude(fiatValue)
      }),
      // Real on-chain hash (when present) is additive — sourceRef stays the
      // content hash so sourceRef-keyed dedup is unaffected.
      txHash,
      chain,
      walletAddress,
      counterpartyAddress,
      notes: mapping.notes ? row[mapping.notes] : assetRaw !== base ? `Pair ${assetRaw}` : undefined,
      flags: fiatValue != null && Math.abs(fiatValue) > 0 ? [] : ['missing_cost_basis'],
      isInternalTransfer: false,
      raw: row
    });
  }

  if (skippedRows > 0) {
    warnings.push(`${skippedRows} row(s) skipped — check type mapping and required columns.`);
  }
  if (transactions.some((t) => t.fiatValue == null)) {
    warnings.push(
      'Some rows have no fiat value. Map a Total or Fiat column, or use Review → Fetch missing prices after import (uses asset + date via CoinGecko).'
    );
  }

  return { transactions, skippedRows, warnings, addressColumnAmbiguous };
}
