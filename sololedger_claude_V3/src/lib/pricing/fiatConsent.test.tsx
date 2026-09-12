import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { convertOrNormalizeForImport, normalizeFiatCurrency, sourceQuote } from './fiatConvert';
import { setMode } from '@/lib/saas/mode';
import { wazirxTradesParser } from '@/lib/parsers/wazirxTrades';
import type { Transaction } from '@/types/transaction';

const settings = { reportingCurrency: 'INR' };
const row = (overrides: Partial<Transaction> = {}): Transaction => ({ id: 'fx', timestamp: Date.parse('2024-07-17'), type: 'buy', asset: 'HNT', amount: 100, fiatCurrency: 'USD', fiatValue: 420.5, source: 'manual', flags: [], isInternalTransfer: false, ...overrides });
const fetchSpy = vi.fn();
beforeEach(() => { setMode('local'); vi.stubGlobal('fetch', fetchSpy); fetchSpy.mockReset(); });
async function allow() { fireEvent.click(await screen.findByRole('button', { name: 'Allow for this batch' })); }

describe('historical currency permission integration', () => {
  it('denial and Escape make no requests, retain execution quote and allow manual INR total', async () => {
    for (const deny of ['button', 'escape', 'close']) {
      const pending = convertOrNormalizeForImport([row()], settings, true);
      const dialog = await screen.findByRole('dialog');
      expect(dialog.textContent).toContain('Frankfurter');
      expect(dialog.textContent).toContain('IP address');
      if (deny === 'button') fireEvent.click(screen.getByRole('button', { name: 'Enter totals manually' }));
      else if (deny === 'close') fireEvent.click(screen.getByRole('button', { name: 'Decline and close currency lookup' }));
      else fireEvent.keyDown(dialog, { key: 'Escape' });
      const result = await pending;
      expect(result.transactions[0]).toMatchObject({ fiatCurrency: 'INR', executionQuote: { amount: 420.5, currency: 'USD' } });
      expect(result.transactions[0].fiatValue).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });
  it('uses actual dated structured rates, deduplicates requests and never bypasses fresh consent for cache', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ base: 'USD', date: '2024-07-17', rates: { INR: 83.56 } }) });
    const pending = convertOrNormalizeForImport([row(), row({ id: 'two' })], settings, false);
    await allow();
    const result = await pending;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.frankfurter.dev/v1/2024-07-17?from=USD&to=INR');
    expect(result.transactions[0].fiatValue).toBeCloseTo(420.5 * 83.56);
    expect(result.transactions[0].fxProvenance).toMatchObject({ provider: 'Frankfurter', requestedDate: '2024-07-17', rateDate: '2024-07-17' });
    fetchSpy.mockClear();
    const denied = convertOrNormalizeForImport([row()], settings, false);
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    expect((await denied).transactions[0].fiatValue).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('keeps imported INR and confirmed zeros without prompting', async () => {
    const result = await convertOrNormalizeForImport([row({ fiatCurrency: 'INR', fiatValue: 9200 }), row({ fiatValue: 0 })], settings, false);
    expect(result.transactions.map(t => t.fiatValue)).toEqual([9200, 0]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('WazirX HNT execution quote remains USDT and fails closed, not a USD peg', async () => {
    const parsed = wazirxTradesParser.parse([{ Date: '2024-07-17 10:00:00', Market: 'HNT/USDT', Price: '4.205', Volume: '100', Total: '420.5', 'Trade Type': 'Buy' }]);
    expect(parsed.transactions[0].fiatCurrency).toBe('USDT');
    expect(normalizeFiatCurrency('USD')).not.toBe(normalizeFiatCurrency('USDT'));
    const result = await convertOrNormalizeForImport(parsed.transactions, settings, false);
    expect(result.transactions[0].executionQuote).toMatchObject({ amount: 420.5, currency: 'USDT' });
    expect(result.transactions[0].fiatValue).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('recovers a previously imported quote from counter consideration without altering known INR', async () => {
    const old = row({ fiatValue: undefined, fiatCurrency: 'INR', counterAsset: 'USDT', counterAmount: 420.5 });
    expect(sourceQuote(old)).toMatchObject({ amount: 420.5, currency: 'USDT' });
    const result = await convertOrNormalizeForImport([old, { ...old, id: 'known', fiatValue: 35000 }], settings, false);
    expect(result.transactions[0].executionQuote?.currency).toBe('USDT');
    expect(result.transactions[1].fiatValue).toBe(35000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('unavailable and invalid future rates remain manual, preserving original consideration', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ base: 'USD', date: '2024-07-21', rates: { INR: 84 } }) });
    const pending = convertOrNormalizeForImport([row({ timestamp: Date.parse('2024-07-20') })], settings, false);
    await allow();
    const result = await pending;
    expect(result.failed).toBe(1);
    expect(result.transactions[0].fiatValue).toBeUndefined();
    expect(result.transactions[0].executionQuote?.amount).toBe(420.5);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

it('memoizes unavailable rates only within the consented batch, including 1000 duplicate rows', async () => {
  fetchSpy.mockResolvedValue({ ok: false });
  const batch = Array.from({ length: 1000 }, (_, i) => row({ id: `failed-${i}`, timestamp: Date.parse('2024-07-22') }));
  const pending = convertOrNormalizeForImport(batch, settings, false);
  await allow();
  expect((await pending).failed).toBe(1000);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const retry = convertOrNormalizeForImport(batch.slice(0, 1), settings, false);
  await allow();
  await retry;
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

it('Binance Options and Hyperliquid parser outputs never request fiat USD rates for USDT/USDC', async () => {
  const { binanceOptionsParser } = await import('@/lib/parsers/binanceOptions');
  const { hyperliquidTradesParser } = await import('@/lib/parsers/hyperliquidTrades');
  const { hyperliquidDepositsParser } = await import('@/lib/parsers/hyperliquidDeposits');
  const options = binanceOptionsParser.parse([{ Time: '2024-07-17 10:00:00', Type: 'premium', Amount: '-420.5', Asset: 'USDT' }]).transactions;
  const trades = hyperliquidTradesParser.parse([
    { time: '07/17/2024 - 10:00:00', coin: 'HNT', dir: 'Close Long', fee: '0.5', closedPnl: '30', px: '4', sz: '10' },
    { time: '07/17/2024 - 11:00:00', coin: 'HNT', dir: 'Close Short', fee: '0.3', closedPnl: '-20', px: '4', sz: '10' }
  ]).transactions;
  const deposits = hyperliquidDepositsParser.parse([{ time: '07/17/2024 - 10:00:00', action: 'deposit', source: 'arbitrum', destination: 'trading', accountValueChange: '50 USDC', fee: '0.2 USDC' }]).transactions;
  expect(options).toHaveLength(1); expect(options[0].fiatCurrency).toBe('USDT');
  expect(trades).toHaveLength(4); expect(trades.every(t => t.fiatCurrency === 'USDC')).toBe(true);
  expect(deposits).toHaveLength(1); expect(deposits[0].fiatCurrency).toBe('USDC');
  const result = await convertOrNormalizeForImport([...options, ...trades, ...deposits, row({ fiatCurrency: 'INR', fiatValue: 9900 })], settings, false);
  expect(result.transactions.slice(0, -1).every(t => t.fiatValue == null && t.executionQuote)).toBe(true);
  expect(result.transactions[result.transactions.length - 1]?.fiatValue).toBe(9900);
  expect(fetchSpy).not.toHaveBeenCalled();
});
