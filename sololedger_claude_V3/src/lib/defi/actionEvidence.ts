import { resolveProtocol } from '@/lib/defi/protocolRegistry';
import type { NeutralDefiAction } from '@/lib/defi/types';
import { isApprovedClassificationRule } from '@/lib/taxonomy/rules';
import type { Transaction } from '@/types/transaction';

const EXACT_EVENT_ID = /^event:(\d+):(0x[0-9a-f]+):(0x[0-9a-f]{40}):(\d+)$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

/**
 * Parse persisted receipt semantics at the report/posting boundary. This is
 * deliberately stricter than structural typing: copied provider labels,
 * snapshots, APY, and address-only guesses cannot become tax evidence.
 */
export function exactStoredDefiAction(value: unknown, transaction?: Transaction): NeutralDefiAction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const action = value as Partial<NeutralDefiAction>;
  if (action.complete !== true || action.evidenceSource !== 'ethereum_log' ||
      typeof action.chainId !== 'number' || typeof action.protocolId !== 'string' ||
      !resolveProtocol(action.chainId, action.protocolId) || typeof action.reserveKey !== 'string' ||
      !ADDRESS.test(action.reserveKey) || typeof action.transactionHash !== 'string' ||
      !/^0x[0-9a-f]+$/.test(action.transactionHash) || typeof action.quantity !== 'string' ||
      !/^[0-9]+$/.test(action.quantity) || typeof action.confidence !== 'number' ||
      !Number.isFinite(action.confidence) || action.confidence < 0.9 ||
      typeof action.ruleId !== 'string' || typeof action.ruleVersion !== 'string' ||
      !isApprovedClassificationRule(action.ruleId, action.ruleVersion) ||
      !Array.isArray(action.eventIds) || action.eventIds.length < 2 ||
      new Set(action.eventIds).size !== action.eventIds.length ||
      !action.eventIds.every((id) => typeof id === 'string' && EXACT_EVENT_ID.test(id))) return undefined;

  const call = action.callEvidence;
  const protocol = resolveProtocol(action.chainId, action.protocolId);
  if (!call || call.status !== 'success' || !['alchemy', 'blockscout', 'ethereum_rpc'].includes(call.provider) ||
      !ADDRESS.test(call.from) || !ADDRESS.test(call.to) || call.to !== protocol?.poolAddress.toLowerCase()) return undefined;
  if (!action.callId || !action.eventIds.includes(action.callId)) return undefined;
  const eventIds = action.eventIds;
  const identities = eventIds.map((id) => EXACT_EVENT_ID.exec(id)!);
  if (identities.some((match) => Number(match[1]) !== action.chainId || match[2] !== action.transactionHash) ||
      ((action.type === 'borrow' || action.type === 'repay') &&
        EXACT_EVENT_ID.exec(action.callId)?.[3] !== protocol.poolAddress.toLowerCase())) return undefined;

  if (!Array.isArray(action.economicLegs) || action.economicLegs.some((leg) =>
    !leg || typeof leg.eventId !== 'string' ||
    (leg.kind !== 'network_fee' && !eventIds.includes(leg.eventId)) ||
    typeof leg.quantity !== 'string' || !/^[0-9]+$/.test(leg.quantity) ||
    typeof leg.contractAddress !== 'string' ||
    (leg.kind !== 'network_fee' && (
      !ADDRESS.test(leg.contractAddress) || EXACT_EVENT_ID.exec(leg.eventId)?.[3] !== leg.contractAddress ||
      !ADDRESS.test(leg.from ?? '') || !ADDRESS.test(leg.to ?? '')
    )))) return undefined;
  const count = (kind: NonNullable<NeutralDefiAction['economicLegs']>[number]['kind'], direction: NonNullable<NeutralDefiAction['economicLegs']>[number]['direction']) =>
    action.economicLegs!.filter((leg) => leg.kind === kind && leg.direction === direction).length;
  const exactUnderlying = (direction: 'in' | 'out') => action.economicLegs!.filter((leg) =>
    leg.kind === 'underlying' && leg.direction === direction && leg.contractAddress === action.reserveKey &&
    leg.quantity === action.quantity).length === 1;
  if (action.type === 'borrow' && (!exactUnderlying('in') || count('debt_token', 'mint') !== 1)) return undefined;
  if (action.type === 'repay' && (!exactUnderlying('out') || count('debt_token', 'burn') !== 1)) return undefined;
  if (action.type === 'interest' && (BigInt(action.quantity) <= 0n ||
      (action.interestKind === 'lending' ? count('protocol_token', 'mint') : count('debt_token', 'mint')) !== 1)) return undefined;

  if (action.type === 'interest' &&
      (action.interestKind !== 'lending' && action.interestKind !== 'borrowing')) return undefined;
  const underlying = action.economicLegs.find((leg) => leg.kind === 'underlying' && leg.quantity === action.quantity);
  const interestMint = action.economicLegs.find((leg) =>
    (leg.kind === 'protocol_token' || leg.kind === 'debt_token') && leg.direction === 'mint');
  if (action.type === 'borrow' && underlying?.to !== call.from) return undefined;
  if (action.type === 'repay' && underlying?.from !== call.from) return undefined;
  if (action.type === 'interest' && interestMint?.to !== call.from) return undefined;
  if (!['borrow', 'repay', 'interest', 'reward', 'supply', 'withdraw', 'liquidation'].includes(action.type ?? '')) return undefined;

  const requiredRole = action.type === 'interest' && action.interestKind === 'lending'
    ? 'protocol_token' : action.type === 'borrow' || action.type === 'repay' || action.type === 'interest'
      ? 'debt_token' : undefined;
  if (requiredRole) {
    const roleLegs = action.economicLegs.filter((leg) => leg.kind === requiredRole);
    if (!Array.isArray(action.registryEvidence) || roleLegs.length !== 1 ||
        !action.registryEvidence.some((mapping) => mapping.role === requiredRole &&
          mapping.contractAddress === roleLegs[0].contractAddress && mapping.protocolId === action.protocolId &&
          mapping.reserveKey === action.reserveKey)) return undefined;
  }

  if (transaction) {
    const transfer = transaction.onchainTransferEvent;
    if (transaction.txHash?.toLowerCase() !== action.transactionHash ||
        transaction.walletAddress?.toLowerCase() !== call.from || transaction.chain !== 'ethereum' ||
        action.postingAnchor !== true || action.postingAnchorRawQuantity !== action.quantity ||
        !Number.isSafeInteger(action.postingAnchorDecimals) || action.postingAnchorDecimals! < 0 ||
        action.postingAnchorDecimals! > 255) return undefined;
    if (action.type === 'interest') {
      if (transaction.contractAddress?.toLowerCase() !== action.reserveKey ||
          transaction.raw?.syntheticDefiComponent !== true || transfer != null) return undefined;
    } else {
      const underlying = action.economicLegs.find((leg) => leg.eventId === action.postingAnchorEventId);
      const match = underlying && EXACT_EVENT_ID.exec(underlying.eventId);
      if (!transfer || !underlying || !match || transfer.chain !== 'ethereum' || transfer.txHash.toLowerCase() !== action.transactionHash ||
          transfer.assetKey.toLowerCase() !== action.reserveKey || transfer.indexKind !== 'log' ||
          String(transfer.index) !== String(Number(match[4])) || transfer.sender.toLowerCase() !== underlying.from ||
          transfer.recipient.toLowerCase() !== underlying.to || transfer.quantity !== action.quantity ||
          transaction.contractAddress?.toLowerCase() !== action.reserveKey) return undefined;
    }
  }
  return action as NeutralDefiAction;
}

export function exactActionDisplayQuantity(action: NeutralDefiAction): number | undefined {
  if (!Number.isSafeInteger(action.postingAnchorDecimals) || action.postingAnchorDecimals! < 0 ||
      action.postingAnchorDecimals! > 255 || !/^[0-9]+$/.test(action.postingAnchorRawQuantity ?? '')) return undefined;
  const decimals = action.postingAnchorDecimals!;
  const raw = action.postingAnchorRawQuantity!;
  const padded = raw.padStart(decimals + 1, '0');
  const value = decimals === 0 ? padded : `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
  const quantity = Number(value);
  return Number.isFinite(quantity) ? quantity : undefined;
}
