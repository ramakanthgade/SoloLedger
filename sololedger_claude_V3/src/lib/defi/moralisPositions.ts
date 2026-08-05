import { getApiBase, isSaasMode } from '@/lib/saas/config';
import { saasProxyFetch } from '@/lib/saas/api';
import { resolveProtocol } from './protocolRegistry';
import type { DefiPositionResult, DefiPositionRow, DebtRateMode, ProtocolId } from './types';

type Json = Record<string, unknown>;
const BASE = 'https://deep-index.moralis.io/api/v2.2';

function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function finite(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
function address(value: unknown): string | undefined {
  const normalized = text(value)?.toLowerCase();
  return normalized && /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : undefined;
}
function rateMode(value: unknown): DebtRateMode | undefined {
  const normalized = text(value)?.toLowerCase();
  return normalized?.includes('stable') ? 'stable' : normalized?.includes('variable') ? 'variable' : undefined;
}

/** Strict adapter for Moralis' evolving detailed-position envelope. Missing debt/detail is partial. */
export function normalizeMoralisPositions(payload: unknown, protocolId: ProtocolId, observedAt = Date.now()): DefiPositionResult {
  const envelope = payload as Json;
  const positions = Array.isArray(payload) ? payload : Array.isArray(envelope?.result) ? envelope.result : undefined;
  if (!positions) return { status: 'partial', chainId: 1, protocolId, rows: [], evidence: [{ provider: 'moralis', status: 'partial', detail: 'Malformed detailed-position response.' }], warnings: ['Moralis detailed positions were malformed.'] };
  const rows: DefiPositionRow[] = [];
  let missingDetail = false;
  let debtStreamDeclared = false;
  for (const item of positions) {
    if (!item || typeof item !== 'object') { missingDetail = true; continue; }
    const position = item as Json;
    const type = (text(position.position_type) ?? text(position.type) ?? '').toLowerCase();
    const tokens = Array.isArray(position.tokens) ? position.tokens.filter((token): token is Json => !!token && typeof token === 'object') : [];
    if (type.includes('borrow') || type.includes('debt')) debtStreamDeclared = true;
    for (const token of tokens) {
      const tokenType = (text(token.token_type) ?? type).toLowerCase();
      const role = tokenType.includes('borrow') || tokenType.includes('debt') || type.includes('borrow') || type.includes('debt') ? 'debt' :
        tokenType.includes('supply') || tokenType.includes('deposit') || tokenType.includes('collateral') || type.includes('supply') || type.includes('lend') ? 'supply' : undefined;
      if (!role) continue;
      const underlyingAddress = address(token.contract_address ?? token.address ?? token.token_address);
      const protocolAddress = address(token.protocol_token_address ?? token.receipt_token_address ?? token.debt_token_address);
      const decimals = finite(token.decimals);
      // Moralis documents `balance` as raw integer units and
      // `balance_formatted` as decimal-adjusted display units.
      const raw = text(token.balance ?? token.balance_raw ?? token.raw_balance);
      const amount = finite(token.balance_formatted ?? token.amount);
      const symbol = text(token.symbol ?? token.label ?? token.name);
      if (!underlyingAddress || !protocolAddress || decimals == null || !Number.isSafeInteger(decimals) || decimals < 0 || !symbol || (raw == null && amount == null)) {
        missingDetail = true; continue;
      }
      const quantity = amount ?? Number(BigInt(raw!)) / 10 ** decimals;
      if (!Number.isFinite(quantity) || quantity < 0) { missingDetail = true; continue; }
      if (quantity === 0) continue;
      const reserveKey = underlyingAddress;
      const mode = role === 'debt' ? rateMode(token.rate_mode ?? token.debt_rate_mode ?? tokenType) : undefined;
      if (role === 'debt' && !mode) { missingDetail = true; continue; }
      const value = finite(token.balance_usd ?? position.balance_usd);
      rows.push({
        id: `moralis:${protocolId}:${reserveKey}:${role}:${mode ?? 'supply'}`,
        snapshotId: '', protocolId, reserveKey, role,
        underlying: { chainId: 1, contractAddress: underlyingAddress, symbol, decimals },
        quantity, rawQuantity: raw ?? String(Math.round(quantity * 10 ** decimals)),
        protocolToken: { chainId: 1, contractAddress: protocolAddress, symbol: text(token.protocol_token_symbol ?? token.protocol_token_label) ?? symbol, decimals },
        ...(role === 'supply' ? { isCollateral: Boolean(token.is_collateral ?? token.is_collateral_enabled) } : { debtRateMode: mode! }),
        ...(value == null ? {} : { valueEvidence: { currency: 'USD' as const, value: Math.abs(value), observedAt, provider: 'moralis' } })
      } as DefiPositionRow);
    }
  }
  // Moralis must explicitly include debt details (or an explicit complete marker); an omitted stream is not proof of zero.
  const declaresComplete = envelope?.complete === true || envelope?.debt_positions_complete === true || debtStreamDeclared;
  const status = missingDetail || (!declaresComplete && positions.length > 0) ? 'partial' : 'complete';
  return { status, chainId: 1, protocolId, rows, evidence: [{ provider: 'moralis', status, detail: status === 'complete' ? 'Detailed positions including debt were returned.' : 'Requested detail or debt completeness was missing.' }], warnings: status === 'partial' ? ['Moralis position detail or debt coverage was incomplete.'] : [] };
}

export async function fetchMoralisPositions(addressValue: string, protocolId: ProtocolId, apiKey: string): Promise<DefiPositionResult> {
  const entry = resolveProtocol(1, protocolId)!;
  const path = `/wallets/${addressValue}/defi/${entry.moralisSlug}/positions?chain=eth`;
  const response = isSaasMode()
    ? await saasProxyFetch(`${getApiBase()}/api/proxy/moralis/api/v2.2${path}`.replace(getApiBase(), ''))
    : await fetch(`${BASE}${path}`, { headers: { 'X-API-Key': apiKey, accept: 'application/json' } });
  if (!response.ok) return { status: 'partial', chainId: 1, protocolId, rows: [], evidence: [{ provider: 'moralis', status: 'unavailable', detail: `HTTP ${response.status}` }], warnings: ['Moralis detailed positions were unavailable.'] };
  return normalizeMoralisPositions(await response.json(), protocolId);
}
