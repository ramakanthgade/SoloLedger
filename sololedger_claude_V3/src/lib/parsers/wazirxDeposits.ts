/**
 * Deposit / withdrawal history sheets (WazirX and similar exchanges).
 *
 * Typical columns:
 *   Date, Transaction, Asset, Amount, Fee, Account Number (INR),
 *   Wallet Address (Crypto), Blockchain Hash (Crypto), Remarks,
 *   INR equivalent price, ...
 */
import type { Transaction, TxType } from '@/types/transaction';
import {
  makeId,
  safeQuantity,
  safeTimestampIst,
  exchangeSourceRef,
  type ExchangeParser
} from './types';
import { headerMap, col, colIncludes } from './headerMap';
import { quoteToFiatCurrency } from './pairUtils';

function norms(headers: string[]): string[] {
  return headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function mapTxType(raw: string): TxType | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  if (t.includes('deposit') || t === 'credit' || t === 'receive') return 'transfer_in';
  if (t.includes('withdraw') || t === 'debit' || t === 'send') return 'transfer_out';
  return null;
}

export const wazirxDepositsParser: ExchangeParser = {
  id: 'wazirx_deposits',
  label: 'Deposits & Withdrawals',

  detect(headers) {
    const h = norms(headers);
    const hasDate = h.some((x) => x.includes('date') || x.includes('time'));
    const hasTx = h.some(
      (x) =>
        x === 'transaction' ||
        x === 'type' ||
        x === 'status' ||
        x.includes('transactiontype')
    );
    const hasAsset = h.some((x) => x === 'asset' || x === 'coin' || x === 'currency' || x === 'token');
    const hasAmount = h.some((x) => x === 'amount' || x === 'quantity' || x === 'qty');
    // WazirX-specific strong signal
    const wazirxSignal =
      h.some((x) => x.includes('walletaddress')) ||
      h.some((x) => x.includes('blockchainhash')) ||
      h.some((x) => x.includes('inrequivalent'));
    return hasDate && hasTx && hasAsset && hasAmount && (wazirxSignal || h.includes('transaction'));
  },

  parse(rows) {
    const transactions: Transaction[] = [];
    const warnings: string[] = [];
    let skippedRows = 0;

    if (rows.length === 0) {
      return { transactions, skippedRows: 0, warnings: ['Sheet has no data rows.'] };
    }

    const map = headerMap(Object.keys(rows[0]));
    const timeCol = col(map, 'date', 'datetime', 'timestamp', 'time') ?? colIncludes(map, 'date');
    const typeCol =
      col(map, 'transaction', 'type', 'transactiontype', 'status') ??
      colIncludes(map, 'transaction', 'type');
    const assetCol = col(map, 'asset', 'coin', 'currency', 'token');
    const amountCol = col(map, 'amount', 'quantity', 'qty');
    const feeCol = col(map, 'fee', 'feeamount');
    const remarksCol = col(map, 'remarks', 'notes', 'comment', 'description');
    const inrEqCol =
      col(map, 'inrequivalentprice', 'inrequivalent', 'fiatvalue') ??
      colIncludes(map, 'inrequivalent');
    const walletCol =
      col(map, 'walletaddresscrypto', 'walletaddress', 'address') ??
      colIncludes(map, 'walletaddress');
    const hashCol =
      col(map, 'blockchainhashcrypto', 'blockchainhash', 'txid', 'hash') ??
      colIncludes(map, 'blockchainhash', 'txid');

    if (!timeCol || !typeCol || !assetCol || !amountCol) {
      return {
        transactions: [],
        skippedRows: rows.length,
        warnings: ['Deposit/withdrawal columns not found (need Date, Transaction, Asset, Amount).']
      };
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const mapped = mapTxType(row[typeCol] || '');
      const timestamp = safeTimestampIst(row[timeCol]);
      const asset = (row[assetCol] || '').trim().toUpperCase();
      const amount = safeQuantity(row[amountCol]);

      if (!mapped || !asset || !Number.isFinite(timestamp) || amount === 0) {
        skippedRows++;
        continue;
      }

      const feeAmount = feeCol ? safeQuantity(row[feeCol]) : undefined;
      const remarks = remarksCol ? (row[remarksCol] || '').trim() : '';
      const wallet = walletCol ? (row[walletCol] || '').trim() : '';
      const txHash = hashCol ? (row[hashCol] || '').trim() : '';
      const inrEq = inrEqCol ? safeQuantity(row[inrEqCol]) : 0;

      // Fiat currency: INR for INR asset or when INR equivalent is present
      const isFiatAsset = Boolean(quoteToFiatCurrency(asset) && ['INR', 'USD', 'EUR', 'GBP'].includes(asset));
      let fiatCurrency = 'INR';
      let fiatValue: number | undefined;
      if (isFiatAsset) {
        fiatCurrency = asset === 'INR' ? 'INR' : asset;
        fiatValue = amount;
      } else if (inrEq > 0) {
        fiatCurrency = 'INR';
        fiatValue = inrEq;
      }

      const notesParts: string[] = [];
      if (remarks) notesParts.push(remarks);
      if (wallet) notesParts.push(`Wallet ${wallet.slice(0, 12)}…`);
      if (txHash) notesParts.push(`Tx ${txHash.slice(0, 14)}…`);

      transactions.push({
        id: makeId('wxdep'),
        timestamp,
        type: mapped,
        asset,
        amount,
        fiatCurrency,
        fiatValue,
        feeAmount: feeAmount && feeAmount > 0 ? feeAmount : undefined,
        feeAsset: feeAmount && feeAmount > 0 ? (isFiatAsset ? asset : asset) : undefined,
        source: 'wazirx_deposits',
        sourceRef: exchangeSourceRef('wazirx', timestamp, mapped, asset, amount),
        notes: notesParts.length > 0 ? notesParts.join(' · ') : undefined,
        flags: ['possible_internal_transfer'],
        isInternalTransfer: false,
        raw: { ...row, _sheetFormat: 'deposits_withdrawals' }
      });
    }

    if (skippedRows > 0) {
      warnings.push(`${skippedRows} deposit/withdrawal row(s) skipped.`);
    }

    return { transactions, skippedRows, warnings };
  }
};
