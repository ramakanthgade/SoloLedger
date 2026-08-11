import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IMPORT_SOURCES, getImportSource } from './importSources';
import { ConnectionWizard } from './ConnectionWizard';
import { PARSERS } from '@/lib/parsers';

const NAMED_EXCHANGE_PARSERS: Record<string, string[]> = {
  binance: ['binance', 'binance_spot', 'binance_transfers', 'binance_options'],
  coinbase: ['coinbase'],
  coindcx: ['coindcx'],
  coinswitch: ['coinswitch'],
  zebpay: ['zebpay'],
  wazirx: ['wazirx_trades', 'wazirx_deposits', 'wazirx_ledger'],
  mudrex: ['mudrex'],
  kraken: ['kraken'],
  kucoin: ['kucoin'],
  cryptocom: ['cryptocom'],
  bybit: ['bybit'],
  okx: ['okx'],
  gateio: ['gateio'],
  bitfinex: ['bitfinex'],
  gemini: ['gemini'],
  htx: ['htx'],
  coinspot: ['coinspot'],
  hyperliquid: ['hyperliquid_trades', 'hyperliquid_deposits']
};

const FLEXIBLE_MAPPED_EXCHANGES = [
  'btcmarkets',
  'mexc',
  'bitvavo',
  'bitstamp',
  'bitget',
  'bitmart',
  'coinex',
  'poloniex',
  'woo',
  'hitbtc',
  'bingx',
  'binanceus',
  'backpack',
  'whitebit',
  'bitflyer',
  'coincheck',
  'bitrue',
  'xt',
  'phemex',
  'lbank'
] as const;

describe('IMPORT_SOURCES — "Other / any exchange" catalog entry', () => {
  it('includes an "other" entry rendered last with exchange-agnostic steps', () => {
    const other = getImportSource('other');
    expect(other).toBeDefined();
    expect(other!.label).toBe('Other / any exchange');
    expect(other!.region).toBe('global');
    // Rendered last (global tiles come after india; "other" is the final global one).
    expect(IMPORT_SOURCES[IMPORT_SOURCES.length - 1].id).toBe('other');
    // Steps are generic, not keyed to a named exchange.
    expect(other!.steps.length).toBeGreaterThanOrEqual(3);
    expect(other!.steps.join(' ')).toMatch(/read the columns automatically/i);
  });

  it('keeps the named-exchange tiles alongside the generic option', () => {
    const ids = IMPORT_SOURCES.map((s) => s.id);
    expect(new Set(ids)).toEqual(new Set([
      ...Object.keys(NAMED_EXCHANGE_PARSERS),
      ...FLEXIBLE_MAPPED_EXCHANGES,
      'other'
    ]));
    expect(ids[ids.length - 1]).toBe('other');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every named file-import entry backed by its registered native parser(s)', () => {
    const parserIds = new Set(PARSERS.map((parser) => parser.id));
    for (const [exchangeId, requiredParserIds] of Object.entries(NAMED_EXCHANGE_PARSERS)) {
      expect(getImportSource(exchangeId), `${exchangeId} is visible in the file catalog`).toBeDefined();
      for (const parserId of requiredParserIds) {
        expect(parserIds.has(parserId), `${exchangeId} uses registered parser ${parserId}`).toBe(true);
      }
    }
  });

  it('labels parserless exchange entry points as flexible mapping without schema or dedup claims', () => {
    for (const exchangeId of FLEXIBLE_MAPPED_EXCHANGES) {
      const source = getImportSource(exchangeId)!;
      const guidance = `${source.steps.join(' ')} ${source.note}`;

      expect(source.fileSupport, exchangeId).toBe('flexible');
      expect(source.formatHint, exchangeId).toMatch(/flexible mapping/i);
      expect(guidance, exchangeId).toMatch(/exact report names and menu path have not been verified/i);
      expect(guidance, exchangeId).toMatch(/auto-detection.*review and map the columns manually/i);
      expect(guidance, exchangeId).toMatch(/No dedicated .* file parser is claimed/i);
      expect(guidance, exchangeId).toMatch(/overlapping API and file history may create duplicates/i);
      expect(guidance, exchangeId).not.toMatch(/expected columns/i);
    }
  });

  it('describes parser-specific report schemas without inventing vendor paths', () => {
    const kraken = getImportSource('kraken')!;
    expect(kraken.formatHint).toMatch(/Ledger History CSV/i);
    expect(kraken.steps.join(' ')).toMatch(/txid, refid, time, type, subtype, asset, amount, fee, balance/i);
    expect(kraken.note).toMatch(/not a trades-only export/i);
    expect(kraken.steps.join(' ')).toMatch(/exact vendor menu path has not been verified/i);

    const bybit = getImportSource('bybit')!;
    expect(bybit.steps.join(' ')).toMatch(/Time, Symbol, Side, Volume, Price, Total, Fee, Fee Currency, Order ID/i);
    expect(bybit.note).toMatch(/does not claim deposit or withdrawal coverage/i);
  });

  it('requires both supported Hyperliquid report types for derivative and collateral coverage', () => {
    const hyperliquid = getImportSource('hyperliquid')!;
    const guidance = `${hyperliquid.steps.join(' ')} ${hyperliquid.note}`;
    expect(guidance).toMatch(/Trade History CSV/i);
    expect(guidance).toMatch(/Deposits \/ Withdrawals CSV/i);
    expect(guidance).toMatch(/drop both files together/i);
    expect(guidance).toMatch(/complete supported derivative and collateral history/i);
  });
});

describe('ConnectionWizard picker renders the "Other" tile', () => {
  it('renders every source tile including "Other / any exchange"', () => {
    render(<ConnectionWizard />);
    // The picker maps over IMPORT_SOURCES with no special-casing per id.
    for (const s of IMPORT_SOURCES) {
      expect(screen.getByText(s.label)).toBeInTheDocument();
    }
    expect(screen.getByText('Other / any exchange')).toBeInTheDocument();
  });
});
