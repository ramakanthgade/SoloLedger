import type { Transaction } from '@/types/transaction';
import type { ExchangeClient, UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import { classifySyncError } from './ccxtLoader';
import { normalizeTrade, normalizeTransfer, resolveMarket } from './normalize';
import { mexcDepositSourceRef } from './mexcIdentity';
export { mexcDepositSourceRef } from './mexcIdentity';

export const MEXC_TRADE_RETENTION_MS = 30 * 86_400_000;
export const MEXC_TRANSFER_RETENTION_MS = 90 * 86_400_000;
export const MEXC_TRADE_LIMIT = 100;
export const MEXC_TRANSFER_LIMIT = 1000;
export const MEXC_MAX_REQUESTS = 8_000;
const MAX_EVIDENCE = 100;

export interface MexcClosedWindow { start: number; end: number }
export interface MexcSymbolWindow extends MexcClosedWindow { symbol: string }
export interface MexcUnsafeEvidence extends MexcClosedWindow {
  id?: string;
  symbol?: string;
  reason: string;
}
export interface MexcTradeCheckpoint {
  requestedStart: number;
  requestedEnd: number;
  symbols: string[];
  pendingWindows: MexcSymbolWindow[];
  completedSymbols: string[];
  nextSymbolIndex: number;
  unsafeEvidence: MexcUnsafeEvidence[];
}
export interface MexcTransferCheckpoint {
  requestedStart: number;
  requestedEnd: number;
  pendingWindows: MexcClosedWindow[];
  unsafeEvidence: MexcUnsafeEvidence[];
}
export interface MexcCheckpoint {
  version: 1;
  trade: MexcTradeCheckpoint;
  deposits: MexcTransferCheckpoint;
  withdrawals: MexcTransferCheckpoint;
}

function plain(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}
function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function validWindow(value: unknown, requestedStart: number, requestedEnd: number, symbolRequired: boolean): boolean {
  if (!plain(value)) return false;
  const keys = symbolRequired ? ['symbol', 'start', 'end'] : ['start', 'end'];
  return exactKeys(value, keys) && (!symbolRequired || (typeof value.symbol === 'string' && value.symbol.trim().length > 0)) &&
    timestamp(value.start) && timestamp(value.end) && value.start >= requestedStart && value.end <= requestedEnd && value.end >= value.start;
}
function validEvidence(value: unknown, requestedStart: number, requestedEnd: number): boolean {
  if (!plain(value) || !Object.keys(value).every((key) => ['id', 'symbol', 'reason', 'start', 'end'].includes(key)) ||
    typeof value.reason !== 'string' || !value.reason.trim() ||
    (value.id != null && (typeof value.id !== 'string' || !value.id.trim())) ||
    (value.symbol != null && (typeof value.symbol !== 'string' || !value.symbol.trim()))) return false;
  return validWindow({ start: value.start, end: value.end }, requestedStart, requestedEnd, false);
}
function validTransfer(value: unknown): value is MexcTransferCheckpoint {
  if (!plain(value) || !exactKeys(value, ['requestedStart', 'requestedEnd', 'pendingWindows', 'unsafeEvidence']) ||
    !timestamp(value.requestedStart) || !timestamp(value.requestedEnd) || value.requestedEnd < value.requestedStart ||
    !Array.isArray(value.pendingWindows) || !Array.isArray(value.unsafeEvidence) || value.unsafeEvidence.length > MAX_EVIDENCE) return false;
  return value.pendingWindows.every((window) => validWindow(window, value.requestedStart as number, value.requestedEnd as number, false)) &&
    new Set(value.pendingWindows.map((window) => JSON.stringify(window))).size === value.pendingWindows.length &&
    value.unsafeEvidence.every((item) => validEvidence(item, value.requestedStart as number, value.requestedEnd as number));
}

/** Strict runtime boundary. Call before constructing a client or touching the network. */
export function assertValidMexcCheckpoint(value: unknown): asserts value is MexcCheckpoint {
  if (!plain(value) || !exactKeys(value, ['version', 'trade', 'deposits', 'withdrawals']) || value.version !== 1 || !plain(value.trade)) {
    throw new Error('MEXC checkpoint is malformed. Restore a valid backup or remove and recreate this connection.');
  }
  const trade = value.trade;
  if (!exactKeys(trade, [
      'requestedStart', 'requestedEnd', 'symbols', 'pendingWindows', 'completedSymbols', 'nextSymbolIndex', 'unsafeEvidence'
    ]) || !timestamp(trade.requestedStart) || !timestamp(trade.requestedEnd) ||
    trade.requestedEnd < trade.requestedStart || !Array.isArray(trade.symbols) ||
    (trade.symbols as unknown[]).some((symbol) => typeof symbol !== 'string' || !symbol.trim()) ||
    new Set(trade.symbols as unknown[]).size !== (trade.symbols as unknown[]).length || !Array.isArray(trade.pendingWindows) ||
    !Array.isArray(trade.completedSymbols) || trade.completedSymbols.some((symbol) =>
      typeof symbol !== 'string' || !(trade.symbols as string[]).includes(symbol)) ||
    new Set(trade.completedSymbols).size !== trade.completedSymbols.length ||
    !Number.isSafeInteger(trade.nextSymbolIndex) || (trade.nextSymbolIndex as number) < 0 ||
    (trade.nextSymbolIndex as number) > Math.max((trade.symbols as string[]).length - 1, 0) ||
    !Array.isArray(trade.unsafeEvidence) || trade.unsafeEvidence.length > MAX_EVIDENCE ||
    !trade.pendingWindows.every((window) => validWindow(window, trade.requestedStart as number, trade.requestedEnd as number, true) &&
      (trade.symbols as string[]).includes((window as { symbol: string }).symbol)) ||
    new Set((trade.pendingWindows as unknown[]).map((window) => JSON.stringify(window))).size !== trade.pendingWindows.length ||
    trade.completedSymbols.some((symbol) => (trade.pendingWindows as unknown[]).some((window) =>
      plain(window) && window.symbol === symbol)) ||
    !trade.unsafeEvidence.every((item) => validEvidence(item, trade.requestedStart as number, trade.requestedEnd as number)) ||
    !validTransfer(value.deposits) || !validTransfer(value.withdrawals)) {
    throw new Error('MEXC checkpoint is malformed. Restore a valid backup or remove and recreate this connection.');
  }
}

function rawRows(client: ExchangeClient): Record<string, unknown>[] {
  return Array.isArray(client.last_json_response)
    ? client.last_json_response.filter((row): row is Record<string, unknown> => plain(row)) : [];
}
interface CapturedPage<T> {
  rows: T[];
  raw: Record<string, unknown>[];
  rawCount: number;
  malformedRaw: boolean;
}
async function captured<T>(client: ExchangeClient, request: () => Promise<T[]>): Promise<CapturedPage<T>> {
  client.last_json_response = undefined;
  const rows = await request();
  const response = client.last_json_response;
  const raw = rawRows(client);
  return {
    rows,
    raw,
    rawCount: Array.isArray(response) ? response.length : 0,
    malformedRaw: !Array.isArray(response) || raw.length !== response.length
  };
}
function split(window: MexcClosedWindow): [MexcClosedWindow, MexcClosedWindow] | undefined {
  if (window.start === window.end) return undefined;
  const mid = window.start + Math.floor((window.end - window.start) / 2);
  return [{ start: window.start, end: mid }, { start: mid + 1, end: window.end }];
}
function evidenceKey(item: MexcUnsafeEvidence): string {
  return [item.symbol ?? '', item.id ?? '', item.start, item.end, item.reason].join('|');
}
function boundedEvidence(items: MexcUnsafeEvidence[]): MexcUnsafeEvidence[] {
  return [...new Map(items.map((item) => [evidenceKey(item), item])).values()].slice(0, MAX_EVIDENCE);
}
function errorNames(error: unknown): Set<string> {
  const names = new Set<string>();
  let current: unknown = error;
  while (current != null && typeof current === 'object') {
    const name = (current as { name?: unknown }).name;
    if (typeof name === 'string') names.add(name);
    current = Object.getPrototypeOf(current);
  }
  return names;
}
function symbolIsNotQueryable(error: unknown): boolean {
  const names = errorNames(error);
  if (names.has('BadSymbol') || names.has('MarketNotFound')) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /invalid symbol|symbol (?:not found|does not exist|is not supported)|unknown market/i.test(message);
}
async function requestPage<T>(args: {
  client: ExchangeClient;
  request: () => Promise<T[]>;
  budget: { used: number; max: number };
  sleep: (ms: number) => Promise<void>;
}): Promise<CapturedPage<T> | undefined> {
  const backoff = [2_000, 5_000, 15_000] as const;
  let retry = 0;
  for (;;) {
    if (args.budget.used >= args.budget.max) return undefined;
    args.budget.used += 1;
    try {
      return await captured(args.client, args.request);
    } catch (error) {
      const retryable = classifySyncError(error) === 'rate_limit' || classifySyncError(error) === 'network';
      if (!retryable || retry >= backoff.length) throw error;
      if (args.budget.used >= args.budget.max) return undefined;
      await args.sleep(backoff[retry]!);
      retry += 1;
    }
  }
}
function tradeId(row: UnifiedTrade): string | undefined {
  const value = row.id ?? row.info?.id;
  return value == null || !String(value).trim() ? undefined : String(value);
}
function safeTrade(row: UnifiedTrade, market: UnifiedMarket | undefined, window: MexcSymbolWindow, now: number): string | undefined {
  const id = tradeId(row);
  if (!id) return 'missing_native_trade_id';
  if (!Number.isSafeInteger(row.timestamp) || row.timestamp! < window.start || row.timestamp! > window.end) return 'timestamp_outside_requested_window';
  if (row.timestamp! > now) return 'future_timestamp';
  if (!normalizeTrade('mexc', row, market)) return 'trade_normalization_failed';
  return undefined;
}

export interface MexcOfflineUniverse {
  symbols: string[];
  unqueryableRecent: string[];
}
function offlineRows(response: unknown): Record<string, unknown>[] {
  if (Array.isArray(response)) return response.filter((row): row is Record<string, unknown> => plain(row));
  if (!plain(response)) return [];
  const candidate = response.data ?? response.symbols;
  return Array.isArray(candidate) ? candidate.filter((row): row is Record<string, unknown> => plain(row)) : [];
}
function malformedOfflineResponse(response: unknown): boolean {
  if (Array.isArray(response)) return false;
  if (!plain(response)) return true;
  return !Array.isArray(response.data ?? response.symbols);
}
export function mapMexcOfflineUniverse(response: unknown, markets: Record<string, UnifiedMarket>, floor: number): MexcOfflineUniverse {
  const byId = new Map<string, string[]>();
  for (const market of Object.values(markets)) {
    const id = market.id?.toUpperCase();
    if (id) byId.set(id, [...(byId.get(id) ?? []), market.symbol]);
  }
  const symbols = new Set<string>();
  const unqueryableRecent: string[] = [];
  for (const row of offlineRows(response)) {
    const native = String(row.symbol ?? row.symbolId ?? row.id ?? '').trim().toUpperCase();
    if (!native) continue;
    const rawTime = Number(row.offlineTime ?? row.offBoardTime ?? row.delistTime ?? row.time);
    // Missing/malformed time is conservatively recent: it must not disappear from coverage.
    if (Number.isFinite(rawTime) && rawTime < floor) continue;
    const matches = byId.get(native) ?? [];
    if (matches.length === 1) symbols.add(matches[0]!);
    else unqueryableRecent.push(native);
  }
  return { symbols: [...symbols].sort(), unqueryableRecent: [...new Set(unqueryableRecent)].sort() };
}

function initialTrade(start: number, end: number, symbols: string[]): MexcTradeCheckpoint {
  return {
    requestedStart: start, requestedEnd: end, symbols,
    pendingWindows: symbols.map((symbol) => ({ symbol, start, end })),
    completedSymbols: [], nextSymbolIndex: 0, unsafeEvidence: []
  };
}
function initialTransfer(start: number, end: number): MexcTransferCheckpoint {
  return { requestedStart: start, requestedEnd: end, pendingWindows: [{ start, end }], unsafeEvidence: [] };
}
export function createMexcCheckpoint(startTrade: number, startTransfers: number, end: number, symbols: string[]): MexcCheckpoint {
  return { version: 1, trade: initialTrade(startTrade, end, symbols), deposits: initialTransfer(startTransfers, end), withdrawals: initialTransfer(startTransfers, end) };
}

export interface MexcScanResult {
  transactions: Transaction[];
  checkpoint?: MexcCheckpoint;
  cursors: { trades?: number; deposits?: number; withdrawals?: number };
  warnings: string[];
  partial: { trades: boolean; deposits: boolean; withdrawals: boolean };
  scannedRanges: Record<'trades' | 'deposits' | 'withdrawals', MexcClosedWindow>;
  counts: { recognized: number; failed: number; terminal: number };
}

const DISCOVERY_EVIDENCE_REASONS = new Set([
  'malformed_offline_symbol_response',
  'unqueryable_recent_offline_symbol'
]);

function pushUniqueWindow<T extends MexcClosedWindow>(windows: T[], window: T): void {
  if (!windows.some((item) => JSON.stringify(item) === JSON.stringify(window))) windows.push(window);
}

function extendCheckpoint(args: {
  checkpoint: MexcCheckpoint;
  symbols: string[];
  now: number;
  tradeStart: number;
  depositStart: number;
  withdrawalStart: number;
}): {
  priorEnds: Record<'trades' | 'deposits' | 'withdrawals', number>;
  tradeCoverageStart: number;
} {
  const priorEnds = {
    trades: args.checkpoint.trade.requestedEnd,
    deposits: args.checkpoint.deposits.requestedEnd,
    withdrawals: args.checkpoint.withdrawals.requestedEnd
  };
  const trade = args.checkpoint.trade;
  // A symbol discovered only on a resumed run has no prior coverage. Give it
  // the retained portion of the checkpoint's original frontier rather than
  // treating the ordinary five-minute overlap as historical coverage.
  const newSymbolStart = Math.max(trade.requestedStart, args.now - MEXC_TRADE_RETENTION_MS);
  const priorSymbols = new Set(trade.symbols);
  trade.symbols = [...new Set([...trade.symbols, ...args.symbols])].sort();
  const newSymbols = trade.symbols.filter((symbol) => !priorSymbols.has(symbol));
  if (args.now > priorEnds.trades) {
    trade.requestedStart = Math.min(trade.requestedStart, args.tradeStart);
    trade.requestedEnd = args.now;
    for (const symbol of trade.symbols) {
      const start = priorSymbols.has(symbol) ? args.tradeStart : newSymbolStart;
      pushUniqueWindow(trade.pendingWindows, { symbol, start, end: args.now });
    }
  } else {
    for (const symbol of newSymbols) {
      pushUniqueWindow(trade.pendingWindows, { symbol, start: newSymbolStart, end: args.now });
    }
  }
  const extendTransfer = (state: MexcTransferCheckpoint, start: number, priorEnd: number) => {
    if (args.now <= priorEnd) return;
    state.requestedStart = Math.min(state.requestedStart, start);
    state.requestedEnd = args.now;
    pushUniqueWindow(state.pendingWindows, { start, end: args.now });
  };
  extendTransfer(args.checkpoint.deposits, args.depositStart, priorEnds.deposits);
  extendTransfer(args.checkpoint.withdrawals, args.withdrawalStart, priorEnds.withdrawals);
  return {
    priorEnds,
    // Once the frozen universe gains a symbol, complete all-symbol coverage
    // can begin only where that newly queryable symbol's retained window does.
    tradeCoverageStart: newSymbols.length > 0 ? newSymbolStart : trade.requestedStart
  };
}

function transferDisposition(kind: 'deposits' | 'withdrawals', row: UnifiedTransfer): 'settled' | 'terminal' | 'unresolved' {
  const status = String(row.info?.status ?? row.status ?? '');
  if (kind === 'deposits') {
    if (status === '5' || status === '12') return 'settled';
    if (['1', '7', '8', '10'].includes(status)) return 'terminal';
    return 'unresolved';
  }
  if (status === '7') return 'settled';
  if (status === '8' || status === '9') return 'terminal';
  return 'unresolved';
}

async function scanTransfers(args: {
  client: ExchangeClient; kind: 'deposits' | 'withdrawals'; checkpoint: MexcTransferCheckpoint;
  now: number; coverageEnd: number; budget: { used: number; max: number }; sleep: (ms: number) => Promise<void>;
}): Promise<{ rows: UnifiedTransfer[]; checkpoint: MexcTransferCheckpoint; terminal: number; scannedEnd: number }> {
  const state: MexcTransferCheckpoint = {
    ...args.checkpoint, pendingWindows: [...args.checkpoint.pendingWindows], unsafeEvidence: [...args.checkpoint.unsafeEvidence]
  };
  const rows: UnifiedTransfer[] = [];
  const seen = new Map<string, string>();
  const pageSignatures = new Set<string>();
  let terminal = 0;
  let scannedEnd = args.coverageEnd;
  while (state.pendingWindows.length > 0 && args.budget.used < args.budget.max) {
    const window = state.pendingWindows.shift()!;
    scannedEnd = Math.max(scannedEnd, window.end);
    const page = await requestPage({ client: args.client, budget: args.budget, sleep: args.sleep, request: () => args.kind === 'deposits'
      ? args.client.fetchDeposits(undefined, window.start, MEXC_TRANSFER_LIMIT, { endTime: window.end })
      : args.client.fetchWithdrawals(undefined, window.start, MEXC_TRANSFER_LIMIT, { endTime: window.end }) });
    if (page == null) {
      state.pendingWindows.unshift(window);
      break;
    }
    if (page.malformedRaw || page.rawCount !== page.rows.length || page.rawCount > MEXC_TRANSFER_LIMIT) {
      state.pendingWindows.unshift(window);
      state.unsafeEvidence = boundedEvidence([...state.unsafeEvidence, { ...window, reason: 'malformed_transfer_page' }]);
      break;
    }
    const pageSignature = JSON.stringify(page.raw);
    if (page.rawCount > 0 && pageSignatures.has(pageSignature)) {
      state.pendingWindows.unshift(window);
      state.unsafeEvidence = boundedEvidence([...state.unsafeEvidence, { ...window, reason: 'repeated_transfer_page' }]);
      break;
    }
    if (page.rawCount > 0) pageSignatures.add(pageSignature);
    if (page.rawCount === MEXC_TRANSFER_LIMIT) {
      const halves = split(window);
      if (!halves) {
        state.pendingWindows.unshift(window);
        state.unsafeEvidence = boundedEvidence([...state.unsafeEvidence, { ...window, reason: 'saturated_1ms_window' }]);
        break;
      }
      state.pendingWindows.unshift(...halves);
      continue;
    }
    state.unsafeEvidence = state.unsafeEvidence.filter((item) =>
      item.id != null || item.start !== window.start || item.end !== window.end);
    for (const row of page.rows) {
      const disposition = transferDisposition(args.kind, row);
      const id = args.kind === 'withdrawals' ? row.id : mexcDepositSourceRef(row);
      const ts = row.timestamp;
      const signature = JSON.stringify(row.info ?? row);
      const prior = id ? seen.get(id) : undefined;
      if (!id || (prior != null && prior !== signature)) {
        state.unsafeEvidence = boundedEvidence([...state.unsafeEvidence, {
          ...window, id, reason: id ? 'conflicting_duplicate_transfer_id' : 'missing_native_transfer_id'
        }]);
        continue;
      }
      if (prior == null) seen.set(id, signature);
      const invalidTime = !Number.isSafeInteger(ts) || ts! < window.start || ts! > window.end || ts! > args.now;
      const normalized = disposition === 'settled' && !invalidTime ? normalizeTransfer('mexc', row) : null;
      // An unresolved observation must recreate its exact replay even when it
      // is the same identity already seen through an overlapping window. Only
      // a settled/terminal provider disposition can retire prior ID evidence.
      if (disposition === 'terminal') {
        state.unsafeEvidence = state.unsafeEvidence.filter((item) => item.id !== id);
        if (prior == null) terminal += 1;
        continue;
      }
      if (disposition === 'settled') {
        state.unsafeEvidence = state.unsafeEvidence.filter((item) => item.id !== id);
      }
      if (normalized) {
        if (prior == null) rows.push(row);
      } else {
        const replay = Number.isSafeInteger(ts) && ts! >= state.requestedStart && ts! <= state.requestedEnd
          ? { start: ts!, end: ts! } : window;
        state.unsafeEvidence = boundedEvidence([...state.unsafeEvidence, {
          ...replay, id, reason: invalidTime ? 'unsafe_transfer_timestamp' : disposition === 'unresolved' ? 'unresolved_transfer_status' : 'transfer_normalization_failed'
        }]);
      }
    }
  }
  // Unsafe economics are exact durable replay work, even after structural exhaustion.
  for (const item of state.unsafeEvidence) {
    if (!state.pendingWindows.some((window) => window.start === item.start && window.end === item.end)) {
      state.pendingWindows.push({ start: item.start, end: item.end });
    }
  }
  return { rows, checkpoint: state, terminal, scannedEnd };
}

async function scanTrades(args: {
  client: ExchangeClient; markets: Record<string, UnifiedMarket>; checkpoint: MexcTradeCheckpoint;
  now: number; coverageEnd: number; budget: { used: number; max: number }; sleep: (ms: number) => Promise<void>;
}): Promise<{ rows: UnifiedTrade[]; checkpoint: MexcTradeCheckpoint; scannedEnd: number }> {
  const state: MexcTradeCheckpoint = {
    ...args.checkpoint, pendingWindows: [...args.checkpoint.pendingWindows],
    completedSymbols: [...args.checkpoint.completedSymbols], unsafeEvidence: [...args.checkpoint.unsafeEvidence]
  };
  const rows: UnifiedTrade[] = [];
  const seen = new Map<string, string>();
  const pageSignatures = new Set<string>();
  let scannedEnd = args.coverageEnd;
  while (state.pendingWindows.length > 0 && args.budget.used < args.budget.max) {
    let processed = false;
    for (let offset = 0; offset < state.symbols.length && args.budget.used < args.budget.max; offset += 1) {
      const index = (state.nextSymbolIndex + offset) % state.symbols.length;
      const symbol = state.symbols[index]!;
      const pendingIndex = state.pendingWindows.findIndex((window) => window.symbol === symbol);
      if (pendingIndex < 0) continue;
      const [window] = state.pendingWindows.splice(pendingIndex, 1);
      state.nextSymbolIndex = (index + 1) % state.symbols.length;
      processed = true;
      scannedEnd = Math.max(scannedEnd, window.end);
      let page: CapturedPage<UnifiedTrade> | undefined;
      try {
        page = await requestPage({
          client: args.client, budget: args.budget, sleep: args.sleep,
          request: () => args.client.fetchMyTrades(symbol, window.start, MEXC_TRADE_LIMIT, { until: window.end })
        });
      } catch (error) {
        if (!symbolIsNotQueryable(error)) throw error;
        state.pendingWindows.push(window);
        state.unsafeEvidence = boundedEvidence([...state.unsafeEvidence, { ...window, symbol, reason: 'symbol_not_queryable' }]);
        continue;
      }
      if (page == null) {
        state.pendingWindows.push(window);
        break;
      }
      if (page.malformedRaw || page.rawCount !== page.rows.length || page.rawCount > MEXC_TRADE_LIMIT) {
        state.pendingWindows.push(window);
        state.unsafeEvidence = boundedEvidence([...state.unsafeEvidence, { ...window, symbol, reason: 'malformed_trade_page' }]);
        continue;
      }
      const pageSignature = JSON.stringify(page.raw);
      if (page.rawCount > 0 && pageSignatures.has(pageSignature)) {
        state.pendingWindows.push(window);
        state.unsafeEvidence = boundedEvidence([...state.unsafeEvidence, { ...window, symbol, reason: 'repeated_trade_page' }]);
        continue;
      }
      if (page.rawCount > 0) pageSignatures.add(pageSignature);
      if (page.rawCount === MEXC_TRADE_LIMIT) {
        const halves = split(window);
        if (!halves) {
          state.pendingWindows.push(window);
          state.unsafeEvidence = boundedEvidence([...state.unsafeEvidence, { ...window, symbol, reason: 'saturated_1ms_window' }]);
        } else state.pendingWindows.push(...halves.map((half) => ({ symbol, ...half })));
        continue;
      }
      let unsafe = false;
      const windowRows: UnifiedTrade[] = [];
      for (const row of page.rows) {
        const id = tradeId(row);
        const signature = JSON.stringify(row.info ?? row);
        const prior = id ? seen.get(id) : undefined;
        const reason = prior != null && prior !== signature ? 'conflicting_duplicate_trade_id'
          : safeTrade(row, resolveMarket(args.markets, row.symbol), window, args.now);
        if (id && prior == null) seen.set(id, signature);
        if (reason) {
          unsafe = true;
          state.unsafeEvidence = boundedEvidence([...state.unsafeEvidence, { ...window, symbol, id, reason }]);
        } else if (id && prior == null) windowRows.push(row);
      }
      if (unsafe) state.pendingWindows.push(window);
      else {
        rows.push(...windowRows);
        state.unsafeEvidence = state.unsafeEvidence.filter((item) =>
          item.symbol !== symbol || item.start !== window.start || item.end !== window.end);
      }
    }
    if (!processed) break;
  }
  const pendingSymbols = new Set(state.pendingWindows.map((window) => window.symbol));
  state.completedSymbols = state.symbols.filter((symbol) => !pendingSymbols.has(symbol));
  return { rows, checkpoint: state, scannedEnd };
}

export async function fetchMexcHistory(args: {
  client: ExchangeClient;
  markets: Record<string, UnifiedMarket>;
  prior?: MexcCheckpoint;
  knownSymbols: string[];
  offlineResponse: unknown;
  now: number;
  tradeStart: number;
  transferStart: number;
  depositStart?: number;
  withdrawalStart?: number;
  tradeBudget?: number;
  transferBudget?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<MexcScanResult> {
  const offline = mapMexcOfflineUniverse(args.offlineResponse, args.markets, args.now - MEXC_TRADE_RETENTION_MS);
  const offlineMalformed = malformedOfflineResponse(args.offlineResponse);
  const symbols = [...new Set([
    ...Object.values(args.markets).filter((market) => market.spot === true).map((market) => market.symbol),
    ...args.knownSymbols, ...offline.symbols
  ])].sort();
  const checkpoint = args.prior ? structuredClone(args.prior)
    : createMexcCheckpoint(args.tradeStart, args.transferStart, args.now, symbols);
  const initialRun = args.prior == null;
  const { priorEnds, tradeCoverageStart } = extendCheckpoint({
    checkpoint,
    symbols,
    now: args.now,
    tradeStart: args.tradeStart,
    depositStart: args.depositStart ?? args.transferStart,
    withdrawalStart: args.withdrawalStart ?? args.transferStart
  });
  // Discovery evidence describes only the current offline-symbol response.
  // Rebuild it every run so a transient malformed/unmappable result cannot
  // pin otherwise complete trade history forever.
  checkpoint.trade.unsafeEvidence = boundedEvidence([
    ...checkpoint.trade.unsafeEvidence.filter((item) => !DISCOVERY_EVIDENCE_REASONS.has(item.reason)),
    ...offline.unqueryableRecent.map((id) => ({
      id, start: checkpoint.trade.requestedStart, end: checkpoint.trade.requestedEnd,
      reason: 'unqueryable_recent_offline_symbol'
    })),
    ...(offlineMalformed ? [{
      start: checkpoint.trade.requestedStart, end: checkpoint.trade.requestedEnd,
      reason: 'malformed_offline_symbol_response'
    }] : [])
  ]);
  const tradeBudget = { used: 0, max: args.tradeBudget ?? MEXC_MAX_REQUESTS };
  // Deposits and withdrawals are independent MEXC endpoints. Give each its
  // own bounded attempt budget so unresolved deposit replay cannot starve a
  // completed withdrawal endpoint (or vice versa) from reaching newer work.
  const depositBudget = { used: 0, max: args.transferBudget ?? MEXC_MAX_REQUESTS };
  const withdrawalBudget = { used: 0, max: args.transferBudget ?? MEXC_MAX_REQUESTS };
  const sleep = args.sleep ?? (async () => {});
  const trades = await scanTrades({ client: args.client, markets: args.markets, checkpoint: checkpoint.trade, now: args.now,
    coverageEnd: initialRun ? checkpoint.trade.requestedStart : priorEnds.trades, budget: tradeBudget, sleep });
  const deposits = await scanTransfers({ client: args.client, kind: 'deposits', checkpoint: checkpoint.deposits, now: args.now,
    coverageEnd: initialRun ? checkpoint.deposits.requestedStart : priorEnds.deposits, budget: depositBudget, sleep });
  const withdrawals = await scanTransfers({ client: args.client, kind: 'withdrawals', checkpoint: checkpoint.withdrawals, now: args.now,
    coverageEnd: initialRun ? checkpoint.withdrawals.requestedStart : priorEnds.withdrawals, budget: withdrawalBudget, sleep });
  const next: MexcCheckpoint = { version: 1, trade: trades.checkpoint, deposits: deposits.checkpoint, withdrawals: withdrawals.checkpoint };
  const tradePartial = next.trade.pendingWindows.length > 0 || next.trade.unsafeEvidence.length > 0;
  const depositPartial = next.deposits.pendingWindows.length > 0;
  const withdrawalPartial = next.withdrawals.pendingWindows.length > 0;
  const warnings = [
    'MEXC API trade history covers only the last month. Export older records from the MEXC website (up to 540 days per export documentation). SoloLedger does not provide a MEXC CSV parser or API/CSV deduplication promise.',
    'MEXC deposit and withdrawal API history covers only the last 90 days. Export older records from MEXC.',
    ...(offline.unqueryableRecent.length ? [`MEXC recent offline symbol(s) could not be mapped to one queryable market (${offline.unqueryableRecent.join(', ')}); trade coverage is partial and no all-symbol completeness claim is made.`] : []),
    ...(offlineMalformed ? ['MEXC offline-symbol discovery returned a malformed response; trade coverage is partial and checkpointed.'] : []),
    ...(tradePartial ? ['MEXC trade traversal is incomplete; its exact closed windows and unsafe evidence were checkpointed for resume.'] : []),
    ...(depositPartial || withdrawalPartial ? ['MEXC transfer traversal has unresolved or incomplete exact windows checkpointed for replay.'] : [])
  ];
  trades.rows.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0) ||
    String(tradeId(left) ?? '').localeCompare(String(tradeId(right) ?? '')));
  deposits.rows.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0) ||
    mexcDepositSourceRef(left).localeCompare(mexcDepositSourceRef(right)));
  withdrawals.rows.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0) ||
    String(left.id ?? '').localeCompare(String(right.id ?? '')));
  const transactions = [
    ...trades.rows.map((row) => normalizeTrade('mexc', row, resolveMarket(args.markets, row.symbol))).filter((row): row is Transaction => row != null),
    ...deposits.rows.map((row) => normalizeTransfer('mexc', row)).filter((row): row is Transaction => row != null),
    ...withdrawals.rows.map((row) => normalizeTransfer('mexc', row)).filter((row): row is Transaction => row != null)
  ];
  const done = !tradePartial && !depositPartial && !withdrawalPartial;
  if (!done) assertValidMexcCheckpoint(next);
  return {
    transactions, checkpoint: done ? undefined : next, warnings,
    cursors: {
      trades: !tradePartial ? next.trade.requestedEnd : undefined,
      deposits: !depositPartial ? next.deposits.requestedEnd : undefined,
      withdrawals: !withdrawalPartial ? next.withdrawals.requestedEnd : undefined
    },
    partial: { trades: tradePartial, deposits: depositPartial, withdrawals: withdrawalPartial },
    scannedRanges: {
      trades: { start: tradeCoverageStart, end: trades.scannedEnd },
      deposits: { start: next.deposits.requestedStart, end: deposits.scannedEnd },
      withdrawals: { start: next.withdrawals.requestedStart, end: withdrawals.scannedEnd }
    },
    counts: { recognized: trades.rows.length + deposits.rows.length + withdrawals.rows.length, failed: next.trade.unsafeEvidence.length + next.deposits.unsafeEvidence.length + next.withdrawals.unsafeEvidence.length, terminal: deposits.terminal + withdrawals.terminal }
  };
}
