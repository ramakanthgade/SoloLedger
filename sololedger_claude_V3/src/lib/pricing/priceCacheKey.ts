import type { SafetyState } from '@/lib/safety/types';
import type { PriceCacheRow } from '@/lib/storage/db';
import { historicalCanonicalPriceId } from './coingecko';

export type PriceCacheKeyKind = 'historical-symbol' | 'historical-contract' | 'current-symbol' | 'current-contract';

export interface ParsedPriceCacheKey {
  kind: PriceCacheKeyKind;
  key: string;
  currency: string;
  canonicalId?: string;
  symbol?: string;
  platform?: string;
  contractAddress?: string;
  markAt?: number;
}

export interface PriceCacheIdentity {
  symbol: string;
  timestampMs: number;
  currency: string;
  source?: string;
  platform?: string;
  contractAddress?: string;
  safetyState?: SafetyState;
}

export interface ResolvedPriceCacheRows {
  exactContract: PriceCacheRow[];
  symbol: PriceCacheRow[];
  rejectedReason?: 'ambiguous-canonical-identity' | 'mismatched-contract' | 'unsafe-symbol-fallback';
}

const DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseDate(value: string): number | undefined {
  const match = DATE_RE.exec(value);
  if (!match) return undefined;
  const year = Number(match[3]);
  const month = Number(match[2]) - 1;
  const day = Number(match[1]);
  const date = Date.UTC(year, month, day);
  const checked = new Date(date);
  return checked.getUTCFullYear() === year && checked.getUTCMonth() === month && checked.getUTCDate() === day
    ? date : undefined;
}

function validToken(value: string): boolean {
  return TOKEN_RE.test(value) && !value.includes(':');
}

/** Strict parser for every persisted v18 historical/current key grammar. */
export function parsePriceCacheKey(key: string): ParsedPriceCacheKey | undefined {
  const parts = key.split(':');
  if (parts[0] === 'sym' && parts.length === 4) {
    const markAt = parseDate(parts[2]);
    if (!validToken(parts[1]) || markAt == null || !validToken(parts[3])) return undefined;
    return { kind: 'historical-symbol', key, symbol: parts[1].toUpperCase(), markAt, currency: parts[3].toUpperCase() };
  }
  if (parts[0] === 'ctr' && parts.length === 5) {
    const markAt = parseDate(parts[3]);
    if (!validToken(parts[1]) || !validToken(parts[2]) || markAt == null || !validToken(parts[4])) return undefined;
    return {
      kind: 'historical-contract', key, platform: parts[1].toLowerCase(),
      contractAddress: parts[2].toLowerCase(), markAt, currency: parts[4].toUpperCase()
    };
  }
  if (parts[0] === 'sym' && parts[1] === 'v2' && parts.length === 5) {
    const markAt = parseDate(parts[3]);
    if (!validToken(parts[2]) || markAt == null || !validToken(parts[4])) return undefined;
    return { kind: 'historical-symbol', key, canonicalId: parts[2], markAt, currency: parts[4].toUpperCase() };
  }
  if (parts[0] === 'ctr' && parts[1] === 'v2' && parts.length === 7) {
    const markAt = parseDate(parts[5]);
    if (![parts[2], parts[3], parts[4], parts[6]].every(validToken) || markAt == null) return undefined;
    return {
      kind: 'historical-contract', key, canonicalId: parts[2], platform: parts[3].toLowerCase(),
      contractAddress: parts[4].toLowerCase(), markAt, currency: parts[6].toUpperCase()
    };
  }
  if (parts[0] === 'spot' && parts[1] === 'sym' && parts.length === 4 &&
      validToken(parts[2]) && validToken(parts[3])) {
    return { kind: 'current-symbol', key, symbol: parts[2].toUpperCase(), currency: parts[3].toUpperCase() };
  }
  if (parts[0] === 'spot' && parts[1] === 'ctr' && parts.length === 5 && parts.slice(2).every(validToken)) {
    return {
      kind: 'current-contract', key, platform: parts[2].toLowerCase(),
      contractAddress: parts[3].toLowerCase(), currency: parts[4].toUpperCase()
    };
  }
  return undefined;
}

export function formatCanonicalSymbolPriceCacheKey(
  canonicalId: string, date: string, currency: string
): string {
  return `sym:v2:${canonicalId}:${date}:${currency.toUpperCase()}`;
}

export function formatCanonicalContractPriceCacheKey(
  canonicalId: string, platform: string, address: string, date: string, currency: string
): string {
  return `ctr:v2:${canonicalId}:${platform.toLowerCase()}:${address.toLowerCase()}:${date}:${currency.toUpperCase()}`;
}

/** Resolve candidates without guessing across identities or unsafe contracts. */
export function resolvePriceCacheRows(
  rows: readonly PriceCacheRow[],
  identity: PriceCacheIdentity,
  parsedByKey?: ReadonlyMap<string, ParsedPriceCacheKey | undefined>
): ResolvedPriceCacheRows {
  const currency = identity.currency.toUpperCase();
  const symbol = identity.symbol.trim().toUpperCase();
  const contract = identity.contractAddress?.trim().toLowerCase();
  const platform = identity.platform?.trim().toLowerCase();
  const canonicalId = historicalCanonicalPriceId(symbol, identity.timestampMs, contract, identity.source);
  const exactContract: PriceCacheRow[] = [];
  const symbolRows: PriceCacheRow[] = [];
  let sawDifferentExactContract = false;

  for (const row of rows) {
    const parsed = parsedByKey?.get(row.key) ?? parsePriceCacheKey(row.key);
    if (!parsed || parsed.currency !== currency || parsed.markAt == null) continue;
    if (parsed.kind === 'historical-contract') {
      if (!contract || !platform || parsed.platform !== platform) continue;
      if (parsed.contractAddress !== contract) {
        if (parsed.canonicalId != null && canonicalId != null && parsed.canonicalId === canonicalId) {
          sawDifferentExactContract = true;
        }
        continue;
      }
      if (parsed.canonicalId != null && parsed.canonicalId !== canonicalId) continue;
      exactContract.push(row);
      continue;
    }
    if (parsed.kind !== 'historical-symbol') continue;
    if (parsed.canonicalId != null ? parsed.canonicalId === canonicalId : parsed.symbol === symbol) symbolRows.push(row);
  }

  if (exactContract.length > 0) return { exactContract, symbol: [] };
  if (sawDifferentExactContract) return { exactContract: [], symbol: [], rejectedReason: 'mismatched-contract' };
  if (canonicalId === null) return { exactContract: [], symbol: [], rejectedReason: 'ambiguous-canonical-identity' };
  if (contract && identity.safetyState !== 'trusted' && identity.safetyState !== 'user_visible') {
    return { exactContract: [], symbol: [], rejectedReason: 'unsafe-symbol-fallback' };
  }
  return { exactContract: [], symbol: symbolRows };
}
