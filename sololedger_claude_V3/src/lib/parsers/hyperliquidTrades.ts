/**
 * Hyperliquid perpetual trade history CSV (Portfolio → Trade History → Export).
 *
 * UI column → CSV header mapping (keep in sync with AGENTS.md):
 *   Time        → time
 *   Market      → coin
 *   Direction   → dir      (Open Long / Open Short / Close Long / Close Short / …)
 *   Price       → px
 *   Size        → sz       (quantity of the perp coin, not USDC)
 *   Trade Value → ntl      (notional = price × size, in USDC)
 *   Fee         → fee      (USDC)
 *   Closed PNL  → closedPnl (realized USDC PnL for this fill)
 *
 * Mapping into SoloLedger (cash-settled perps — do NOT create spot BTC/ETH lots):
 *   - Every fill with fee > 0 → `fee` USDC (portfolio −)
 *   - Open / Add fills: ignore closedPnl (it equals −fee on Hyperliquid exports)
 *   - Close / Liquidate with closedPnl > 0 → `income` USDC (taxable profit + portfolio +)
 *   - Close / Liquidate with closedPnl < 0 → `fee` USDC with category `perp_loss`
 *     (portfolio − without inventing a taxable USDC disposal / fake capital gain)
 */
import type { Transaction } from '@/types/transaction';
import {
  makeId,
  exchangeSourceRef,
  type ExchangeParser
} from './types';
import { headerMap, col, colIncludes } from './headerMap';

function norms(headers: string[]): string[] {
  return headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/** Parse `DD/MM/YYYY - HH:mm:ss` (Hyperliquid UI / CSV). Falls back to Date.parse. */
export function parseHyperliquidTime(raw: string | undefined): number {
  if (!raw) return NaN;
  const s = String(raw).trim();
  const m = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*[-–]\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/
  );
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = Number(m[6] ?? 0);
    // Treat as UTC wall-clock (export has no timezone); consistent across imports.
    return Date.UTC(year, month - 1, day, hour, minute, second);
  }
  return Date.parse(s);
}

/** Strip "USDC" / commas from Hyperliquid numeric cells. Preserves sign (for closedPnl). */
export function parseHyperliquidNumber(raw: string | undefined): number {
  if (!raw) return 0;
  const cleaned = String(raw)
    .replace(/,/g, '')
    .replace(/\s*USDC\s*/gi, '')
    .trim();
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function isOpenDir(dir: string): boolean {
  const d = dir.toLowerCase();
  return d.includes('open') || d.startsWith('add ') || d.includes('add long') || d.includes('add short');
}

function isCloseDir(dir: string): boolean {
  const d = dir.toLowerCase();
  return d.includes('close') || d.includes('liquidat');
}

export const hyperliquidTradesParser: ExchangeParser = {
  id: 'hyperliquid_trades',
  label: 'Hyperliquid Perp Trades',

  detect(headers) {
    const h = norms(headers);
    const hasTime = h.includes('time') || h.some((x) => x.includes('time'));
    const hasCoin = h.includes('coin');
    const hasDir = h.includes('dir');
    const hasPx = h.includes('px');
    const hasSz = h.includes('sz');
    const hasClosedPnl = h.includes('closedpnl');
    // Strong Hyperliquid signature: abbreviated cols + closedPnl
    if (hasTime && hasCoin && hasDir && hasPx && hasSz && hasClosedPnl) return true;
    // Full UI header names if someone renames the CSV
    const hasMarket = h.includes('market');
    const hasDirection = h.includes('direction');
    const hasClosedPnlFull = h.some((x) => x.includes('closedpnl') || x === 'closedpnl');
    return hasTime && hasMarket && hasDirection && hasClosedPnlFull;
  },

  parse(rows) {
    const transactions: Transaction[] = [];
    const warnings: string[] = [];
    let skippedRows = 0;
    let openIgnoredPnl = 0;
    let profitCount = 0;
    let lossCount = 0;
    let feeCount = 0;

    if (rows.length === 0) {
      return { transactions, skippedRows: 0, warnings: ['Sheet has no data rows.'] };
    }

    const map = headerMap(Object.keys(rows[0]));
    const timeCol = col(map, 'time', 'timestamp', 'date') ?? colIncludes(map, 'time');
    const coinCol = col(map, 'coin', 'market', 'asset', 'symbol');
    const dirCol = col(map, 'dir', 'direction', 'side');
    const pxCol = col(map, 'px', 'price');
    const szCol = col(map, 'sz', 'size', 'quantity', 'qty');
    const ntlCol = col(map, 'ntl', 'tradevalue', 'notional');
    const feeCol = col(map, 'fee');
    const pnlCol = col(map, 'closedpnl') ?? colIncludes(map, 'closedpnl');

    if (!timeCol || !coinCol || !dirCol) {
      return {
        transactions: [],
        skippedRows: rows.length,
        warnings: ['Hyperliquid trade columns not found (need time, coin, dir).']
      };
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const dir = (row[dirCol] || '').trim();
      const coin = (row[coinCol] || '').trim().toUpperCase();
      const timestamp = parseHyperliquidTime(row[timeCol]);
      if (!dir || !coin || !Number.isFinite(timestamp)) {
        skippedRows++;
        continue;
      }

      const fee = Math.abs(feeCol ? parseHyperliquidNumber(row[feeCol]) : 0);
      const closedPnl = pnlCol ? parseHyperliquidNumber(row[pnlCol]) : 0;
      const px = Math.abs(pxCol ? parseHyperliquidNumber(row[pxCol]) : 0);
      const sz = Math.abs(szCol ? parseHyperliquidNumber(row[szCol]) : 0);
      const ntl = Math.abs(ntlCol ? parseHyperliquidNumber(row[ntlCol]) : px > 0 && sz > 0 ? px * sz : 0);

      const notesBase = `${dir} ${coin}${px > 0 ? ` @ ${px}` : ''}${sz > 0 ? ` × ${sz}` : ''}${
        ntl > 0 ? ` (ntl ${ntl} USDC)` : ''
      }`;

      // Trading fee — always a separate USDC debit when present
      if (fee > 0) {
        feeCount++;
        transactions.push({
          id: makeId('hlfee'),
          timestamp,
          type: 'fee',
          asset: 'USDC',
          amount: fee,
          feeAmount: fee,
          feeAsset: 'USDC',
          fiatCurrency: 'USD',
          fiatValue: fee,
          source: 'hyperliquid_trades',
          sourceRef: exchangeSourceRef('hyperliquid', timestamp, 'fee', coin, fee),
          notes: `Perp fee · ${notesBase}`,
          flags: [],
          isInternalTransfer: false,
          category: 'perp',
          instrumentClass: 'derivative',
          raw: { ...row, _hlKind: 'fee' }
        });
      }

      if (isOpenDir(dir)) {
        // closedPnl on opens equals −fee in HL exports — already captured as fee above
        if (Math.abs(closedPnl) > 1e-12) openIgnoredPnl++;
        continue;
      }

      if (isCloseDir(dir)) {
        if (Math.abs(closedPnl) < 1e-12) continue;

        if (closedPnl > 0) {
          profitCount++;
          transactions.push({
            id: makeId('hlpnl'),
            timestamp,
            type: 'income',
            asset: 'USDC',
            amount: closedPnl,
            fiatCurrency: 'USD',
            fiatValue: closedPnl,
            source: 'hyperliquid_trades',
            sourceRef: exchangeSourceRef('hyperliquid', timestamp, 'income', coin, closedPnl),
            notes: `Perp profit · ${notesBase}`,
            flags: [],
            isInternalTransfer: false,
            category: 'perp',
            instrumentClass: 'derivative',
            raw: { ...row, _hlKind: 'perp_profit' }
          });
        } else {
          lossCount++;
          const loss = Math.abs(closedPnl);
          transactions.push({
            id: makeId('hlpnl'),
            timestamp,
            type: 'fee',
            asset: 'USDC',
            amount: loss,
            feeAmount: loss,
            feeAsset: 'USDC',
            fiatCurrency: 'USD',
            fiatValue: loss,
            source: 'hyperliquid_trades',
            sourceRef: exchangeSourceRef('hyperliquid', timestamp, 'perp_loss', coin, loss),
            notes: `Perp loss · ${notesBase}`,
            flags: [],
            isInternalTransfer: false,
            category: 'perp_loss',
            instrumentClass: 'derivative',
            raw: { ...row, _hlKind: 'perp_loss' }
          });
        }
        continue;
      }

      // Spot Buy/Sell on HL or unknown dir — skip with warning count
      skippedRows++;
    }

    if (skippedRows > 0) {
      warnings.push(`${skippedRows} Hyperliquid row(s) skipped (missing data or unsupported direction).`);
    }
    warnings.push(
      `Hyperliquid perps: ${feeCount} fee(s), ${profitCount} profit close(s) as income, ${lossCount} loss close(s) as perp_loss. ` +
        `Underlying coins are not imported as spot holdings.`
    );
    if (openIgnoredPnl > 0) {
      warnings.push(
        `Ignored closedPnl on ${openIgnoredPnl} Open/Add fill(s) (equals trading fee in Hyperliquid exports).`
      );
    }

    return { transactions, skippedRows, warnings };
  }
};
