/**
 * Binance standalone "Deposit History" / "Withdrawal History" CSV exports
 * (Wallet → Transaction History → Deposit / Withdraw tabs → Export, or the
 * "Deposit & Withdrawal History" statement).
 *
 * Typical columns:
 *   Deposit:    Date(UTC), Coin, Network, Amount, TXID, Status
 *   Withdrawal: Date(UTC), Coin, Network, Amount, Fee, Address, TXID, Status
 *
 * Handled header variants: `Date` / `Time` instead of `Date(UTC)`,
 * `Transaction ID` instead of `TXID`, optional `Address` on deposits, and
 * combined exports that carry a per-row `Type` (Deposit/Withdraw) column.
 *
 * These files have no Operation/Change ledger columns, so the full-ledger
 * `binanceParser` never claims them, and they carry no explicit trade side,
 * so previously they fell through to the generic fallback (which cannot
 * resolve a type without a report-title preamble) and ended at manual
 * column mapping.
 *
 * Direction resolution per row, most specific first:
 *   1. Explicit `Type` column value (combined exports).
 *   2. Report-title implied type (SheetContext — e.g. a "Deposit History"
 *      preamble row above the header).
 *   3. Column-shape heuristic: Binance withdrawal exports carry a network
 *      `Fee` column; deposit exports do not.
 *
 * Deposits map to `transfer_in`, withdrawals to `transfer_out` with
 * `possible_internal_transfer` — exactly how the full-ledger stitcher
 * (binanceStitch.ts) classifies `Deposit` / `Withdraw` operations today.
 */
import type { Transaction, TxType } from '@/types/transaction';
import {
  exchangeSourceRef,
  makeId,
  safeQuantity,
  safeTimestampUtc,
  type ExchangeParser
} from './types';
import { headerMap, col } from './headerMap';
import { isRealTxHash, isValidTxHashForChain, normalizeChain } from './explorer';

interface BinanceTransferColumns {
  dateCol?: string;
  coinCol?: string;
  networkCol?: string;
  amountCol?: string;
  txidCol?: string;
  typeCol?: string;
  feeCol?: string;
  addressCol?: string;
  statusCol?: string;
}

function analyzeHeaders(headers: string[]): BinanceTransferColumns {
  const map = headerMap(headers);
  return {
    dateCol: col(map, 'dateutc', 'date', 'time', 'datetime', 'timestamp'),
    coinCol: col(map, 'coin'),
    networkCol: col(map, 'network'),
    amountCol: col(map, 'amount'),
    txidCol: col(map, 'txid', 'transactionid', 'transactionhash', 'txhash', 'hash'),
    typeCol: col(map, 'type', 'direction'),
    feeCol: col(map, 'fee', 'transactionfee', 'networkfee'),
    addressCol: col(map, 'address', 'depositaddress', 'withdrawaladdress', 'recipientaddress'),
    statusCol: col(map, 'status', 'state')
  };
}

/** Statuses that mean the transfer actually settled; anything else is skipped. */
const SETTLED_STATUSES = new Set([
  'completed',
  'complete',
  'success',
  'successful',
  'confirmed',
  'credited',
  'finished'
]);

function explicitRowType(raw: string | undefined): TxType | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return null;
  if (v.includes('deposit') || v.includes('receive') || v === 'credit') return 'transfer_in';
  if (v.includes('withdraw') || v.includes('send') || v === 'debit') return 'transfer_out';
  return null;
}

/**
 * Binance export timestamps are UTC-documented (`Date(UTC)`), so anchor bare
 * strings to UTC. Some regional exports use `DD-MM-YYYY HH:mm:ss` — normalize
 * that shape explicitly BEFORE the generic parse: V8 `Date.parse` accepts
 * `DD-MM-YYYY` as MM-DD-YYYY LOCAL time, which would swap day/month (for days
 * 1–12) and anchor to the local timezone instead of UTC.
 */
function parseBinanceTime(v: string | undefined): number {
  const m = String(v ?? '')
    .trim()
    .match(/^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)/);
  if (m) return Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}Z`);
  return safeTimestampUtc(v);
}

export const binanceTransfersParser: ExchangeParser = {
  id: 'binance_transfers',
  label: 'Binance Deposit & Withdrawal History',

  detect(headers) {
    const c = analyzeHeaders(headers);
    // The Coin + Network + TXID trio is Binance-specific: Kraken (txid+refid)
    // and Crypto.com (Transaction Hash) exports lack the Coin/Network pair,
    // and Binance's own full ledger / trade-history exports have no Network
    // or TXID column.
    return Boolean(c.dateCol && c.coinCol && c.networkCol && c.amountCol && c.txidCol);
  },

  parse(rows, ctx) {
    const transactions: Transaction[] = [];
    const warnings: string[] = [];
    let skippedRows = 0;
    let skippedUnsettled = 0;

    if (rows.length === 0) {
      return { transactions, skippedRows: 0, warnings: ['File has no data rows.'] };
    }

    const c = analyzeHeaders(Object.keys(rows[0]));
    if (!c.dateCol || !c.coinCol || !c.amountCol) {
      return {
        transactions: [],
        skippedRows: rows.length,
        warnings: ['Binance deposit/withdrawal columns not found — try manual or AI mapping.']
      };
    }

    const implied =
      ctx?.impliedType === 'transfer_in' || ctx?.impliedType === 'transfer_out'
        ? ctx.impliedType
        : null;
    // Column-shape fallback: a network-fee column means a withdrawal export.
    const shapeType: TxType = c.feeCol ? 'transfer_out' : 'transfer_in';

    for (const row of rows) {
      if (c.statusCol) {
        const status = (row[c.statusCol] ?? '').trim().toLowerCase();
        if (status && !SETTLED_STATUSES.has(status)) {
          skippedUnsettled++;
          continue;
        }
      }

      const type = explicitRowType(c.typeCol ? row[c.typeCol] : undefined) ?? implied ?? shapeType;
      const timestamp = parseBinanceTime(row[c.dateCol]);
      const coin = (row[c.coinCol] ?? '').trim().toUpperCase();
      const amount = safeQuantity(row[c.amountCol]);

      if (!coin || amount === 0 || !Number.isFinite(timestamp)) {
        skippedRows++;
        continue;
      }

      const network = c.networkCol ? (row[c.networkCol] ?? '').trim() : '';
      const chain = normalizeChain(network);
      const rawTxHash = c.txidCol ? (row[c.txidCol] ?? '').trim() : '';
      // Same guard as the generic mapper: only keep a hash that is real and
      // matches the row chain's shape, so explorer links never break.
      const txHash =
        rawTxHash && isRealTxHash(rawTxHash) && isValidTxHashForChain(chain, rawTxHash)
          ? rawTxHash
          : undefined;
      const fee = c.feeCol ? safeQuantity(row[c.feeCol]) : 0;
      const address = c.addressCol ? (row[c.addressCol] ?? '').trim() : '';

      transactions.push({
        id: makeId('bntransfer'),
        timestamp,
        type,
        asset: coin,
        amount,
        // Binance charges the withdrawal network fee in the withdrawn coin.
        feeAmount: fee > 0 ? fee : undefined,
        feeAsset: fee > 0 ? coin : undefined,
        fiatCurrency: 'USD',
        fiatValue: undefined,
        source: 'binance_transfers',
        sourceRef: exchangeSourceRef('binance', timestamp, type, coin, amount),
        txHash,
        // Withdrawal Address is the destination (counterparty); a deposit
        // Address is the user's own Binance deposit address (wallet side).
        counterpartyAddress: type === 'transfer_out' && address ? address : undefined,
        walletAddress: type === 'transfer_in' && address ? address : undefined,
        chain,
        notes: `${type === 'transfer_in' ? 'Deposit' : 'Withdrawal'}${network ? ` via ${network}` : ''}`,
        flags: ['possible_internal_transfer'],
        isInternalTransfer: false,
        raw: row
      });
    }

    if (skippedUnsettled > 0) {
      warnings.push(
        `${skippedUnsettled} row(s) skipped — status not completed (pending/failed/rejected).`
      );
    }
    if (skippedRows > 0) {
      warnings.push(`${skippedRows} row(s) skipped — missing time, coin, or amount.`);
    }
    const deposits = transactions.filter((t) => t.type === 'transfer_in').length;
    const withdrawals = transactions.filter((t) => t.type === 'transfer_out').length;
    if (deposits + withdrawals > 0) {
      warnings.push(
        `${deposits} deposit(s) and ${withdrawals} withdrawal(s) imported — mark internal transfers in Review if moving between your own wallets.`
      );
    }

    return { transactions, skippedRows: skippedRows + skippedUnsettled, warnings };
  }
};
