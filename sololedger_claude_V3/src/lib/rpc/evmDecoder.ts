import type { TxType } from '@/types/transaction';
import type { NeutralDefiAction, NeutralDefiActionType } from '@/lib/defi/types';
import { PROTOCOL_REGISTRY, resolveProtocol } from '@/lib/defi/protocolRegistry';

export const ERC_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const ERC4626_DEPOSIT_TOPIC = '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7';

export interface EvmLogEntry { address: string; topics: string[]; data: string; logIndex?: number | string }
export interface EvmTxReceipt {
  transactionHash: string;
  logs: EvmLogEntry[];
  to?: string;
  from?: string;
  gasUsed?: string;
  effectiveGasPrice?: string;
}
export interface EvmDecodeResult {
  type: TxType;
  asset?: string;
  amount?: number;
  rawAmount?: string;
  contractAddress?: string;
  counterpartyAddress?: string;
  notes?: string;
  confidence: 'high' | 'medium';
}
type KnownContract = { label: string; role: string };
export interface EvmTransferMatch {
  contractAddress?: string;
  direction: 'transfer_in' | 'transfer_out';
  from?: string;
  to?: string;
  /** Exact base-unit value from provider rawContract.value. */
  rawQuantity?: string;
}

export const KNOWN_PROTOCOL_CONTRACTS: Record<string, KnownContract> = {
  ...Object.fromEntries(Object.values(PROTOCOL_REGISTRY).map((entry) => [
    entry.poolAddress.toLowerCase(),
    { label: `${entry.protocol} ${entry.version} Pool`, role: 'deposit_target' }
  ])),
  '0xd784927ff2f95ba542bfc824c8a8a98f3495f6b5': { label: 'Aave v2 IncentivesController', role: 'rewards_source' },
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': { label: 'Uniswap V2 Router', role: 'router' },
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': { label: 'Uniswap V3 Router', role: 'router' },
  '0xba12222222228d8ba445958a75a0704d566bf2c8': { label: 'Balancer Vault', role: 'router' }
};
const TOKEN_META: Record<string, { symbol: string; decimals: number }> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': { symbol: 'UNI', decimals: 18 },
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': { symbol: 'AAVE', decimals: 18 }
};

/** Canonical controllers whose event ABI and protocol ownership are registry-reviewed. */
export const CANONICAL_DEFI_EVENT_CONTRACTS: Readonly<Record<string, DefiEventContract>> = Object.freeze({
  ...Object.fromEntries(Object.values(PROTOCOL_REGISTRY).flatMap((entry) =>
    [
      ...entry.rewardControllerAddresses.map((address) => [address.toLowerCase(), Object.freeze({
        protocolId: entry.id, reserveKey: 'unknown', role: 'reward_controller' as const
      })]),
      ...entry.rewardSourceAddresses.map((address) => [address.toLowerCase(), Object.freeze({
        protocolId: entry.id, reserveKey: 'unknown', role: 'reward_source' as const
      })]),
      ...entry.rewardTokenAddresses.map((address) => [address.toLowerCase(), Object.freeze({
        protocolId: entry.id, reserveKey: address.toLowerCase(), role: 'reward' as const
      })])
    ]))
});

type EventVersion = 'pool-v2' | 'pool-v3' | 'pool-shared' | 'token-v3' | 'rewards-v2' | 'rewards-v3';
interface AaveEventSpec { type: NeutralDefiActionType; version: EventVersion }
const AAVE_EVENT_SPECS: Readonly<Record<string, AaveEventSpec>> = Object.freeze({
  // Canonical Aave/Spark ABI signatures. Supply/Deposit and Borrow keep user
  // in data word 0 and amount in data word 1; they must never use a generic
  // first-word amount decoder.
  '0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61': { type: 'supply', version: 'pool-v3' },
  '0xde6857219544bb5b7746f48ed30be6386fefc61b2f864cacf559893bf50fd951': { type: 'supply', version: 'pool-v2' },
  '0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7': { type: 'withdraw', version: 'pool-shared' },
  '0xc6a898309e823ee50bac64e45ca8adba6690e99e7841c45d754e2a38e9019d9b': { type: 'borrow', version: 'pool-v2' },
  '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0': { type: 'borrow', version: 'pool-v3' },
  '0x4cdde6e09bb755c9a5589ebaec640bbfedff1362d4b255ebf8339782b9942faa': { type: 'repay', version: 'pool-v2' },
  '0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051': { type: 'repay', version: 'pool-v3' },
  '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286': { type: 'liquidation', version: 'pool-shared' },
  '0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196': { type: 'interest', version: 'token-v3' },
  // RewardsClaimed(address,address,uint256) — Aave v2 IncentivesController.
  '0x9310ccfcb8de723f578a9e4282ea9f521f05ae40dc08f3068dfad528a65ee3c7': { type: 'reward', version: 'rewards-v2' },
  '0xc052130bc4ef84580db505783484b067ea8b71b3bca78a7e12db7aea8658f004': { type: 'reward', version: 'rewards-v3' }
});

export interface DefiEventContract {
  protocolId: string;
  reserveKey: string;
  role?: 'protocol_token' | 'debt_token' | 'reward' | 'reward_controller' | 'reward_source';
}

interface PositionTokenMappingRow {
  protocolId: string;
  reserveKey: string;
  role: 'supply' | 'debt';
  underlying: { contractAddress: string };
  protocolToken: { contractAddress: string };
}

/** Build only registry-backed mappings persisted by the A3 position authority. */
export function defiEventContractsFromPositions(
  chainId: number,
  rows: readonly PositionTokenMappingRow[]
): Record<string, DefiEventContract> {
  const output: Record<string, DefiEventContract> = {};
  for (const row of rows) {
    if (!resolveProtocol(chainId, row.protocolId)) continue;
    const reserveKey = row.reserveKey.toLowerCase();
    const underlying = row.underlying.contractAddress.toLowerCase();
    const protocolToken = row.protocolToken.contractAddress.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(reserveKey) || underlying !== reserveKey ||
      !/^0x[0-9a-f]{40}$/.test(protocolToken)) continue;
    output[underlying] = { protocolId: row.protocolId, reserveKey };
    output[protocolToken] = {
      protocolId: row.protocolId,
      reserveKey,
      role: row.role === 'debt' ? 'debt_token' : 'protocol_token'
    };
  }
  return output;
}

function word(data: string, index = 0): string | null {
  const clean = data.replace(/^0x/, '');
  const value = clean.slice(index * 64, (index + 1) * 64);
  return value.length === 64 ? uint256(value) : null;
}

function canonicalLogIndex(value: EvmLogEntry['logIndex']): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(normalized)) return null;
  const parsed = Number(BigInt(normalized));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function exactLogId(chainId: number, txHash: string, log: EvmLogEntry): string | undefined {
  const logIndex = canonicalLogIndex(log.logIndex);
  return logIndex == null ? undefined :
    `event:${chainId}:${txHash.toLowerCase()}:${log.address.toLowerCase()}:${logIndex}`;
}

function dataAddress(data: string, index: number): string | null {
  const value = word(data, index);
  return value == null ? null : `0x${value.slice(-40).toLowerCase()}`;
}

function exactWord(data: string, index: number): string | undefined {
  return word(data, index) ?? undefined;
}

function protocolForPool(chainId: number, address: string) {
  const normalized = address.toLowerCase();
  return Object.values(PROTOCOL_REGISTRY).find((entry) =>
    entry.chainId === chainId && entry.poolAddress.toLowerCase() === normalized
  );
}

function protocolVersionMatches(version: EventVersion, protocolVersion: 'v1' | 'v2' | 'v3'): boolean {
  if (version === 'pool-v2') return protocolVersion === 'v2';
  if (version === 'pool-v3') return protocolVersion === 'v3' || protocolVersion === 'v1';
  if (version === 'rewards-v2') return protocolVersion === 'v2';
  if (version === 'rewards-v3') return protocolVersion === 'v3' || protocolVersion === 'v1';
  return true;
}

type RewardLayout = 'aave-v2' | 'aave-v3' | 'spark-v1';
function rewardLayout(protocolId: string): RewardLayout | undefined {
  return protocolId === 'aave-v2-ethereum' ? 'aave-v2' :
    protocolId === 'aave-v3-ethereum' ? 'aave-v3' :
      protocolId === 'spark-v1-ethereum' ? 'spark-v1' : undefined;
}

function abiShapeComplete(log: EvmLogEntry, spec: AaveEventSpec, layout?: RewardLayout): boolean {
  const dataWords = spec.type === 'supply' ? 2 : spec.type === 'borrow' ? 4 :
    spec.type === 'withdraw' ? 1 : spec.type === 'repay' ? spec.version === 'pool-v2' ? 1 : 2 :
      spec.type === 'liquidation' ? 4 : spec.type === 'interest' ? 3 :
        layout === 'aave-v2' ? 1 : 2;
  const topicCount = spec.type === 'interest' ? 3 : spec.type === 'reward' && layout === 'aave-v2' ? 3 : 4;
  return log.topics.length === topicCount &&
    word(log.data, dataWords - 1) != null;
}

/**
 * Decode action evidence from exact Ethereum logs. Each protocol event remains
 * a separate call boundary. Transfer legs are correlated only when ABI asset,
 * amount, direction and represented participant produce a unique candidate.
 */
export function decodeNeutralDefiActions(
  receipt: EvmTxReceipt,
  chainId = 1,
  eventContracts: Readonly<Record<string, DefiEventContract>> = CANONICAL_DEFI_EVENT_CONTRACTS,
  walletAddress?: string
): NeutralDefiAction[] {
  const wallet = walletAddress?.toLowerCase();
  const validatedContracts = { ...CANONICAL_DEFI_EVENT_CONTRACTS, ...eventContracts };
  const transferLegs = (receipt.logs ?? []).flatMap((log) => {
    if (log.topics?.[0]?.toLowerCase() !== ERC_TRANSFER_TOPIC || log.topics.length !== 3) return [];
    const eventId = exactLogId(chainId, receipt.transactionHash, log);
    const from = addressFromTopic(log.topics[1]);
    const to = addressFromTopic(log.topics[2]);
    const quantity = uint256(log.data);
    if (!eventId || !from || !to || quantity == null) return [];
    const mapped = validatedContracts[log.address.toLowerCase()];
    return [{
      eventId, from, to, quantity, contractAddress: log.address.toLowerCase(), mapped,
      direction: from === `0x${'0'.repeat(40)}` ? 'mint' as const :
        to === `0x${'0'.repeat(40)}` ? 'burn' as const : to === wallet ? 'in' as const : 'out' as const
    }];
  });
  const actions: NeutralDefiAction[] = [];
  for (let index = 0; index < (receipt.logs ?? []).length; index++) {
    const log = receipt.logs[index];
    const protocol = protocolForPool(chainId, log.address);
    const mappedEvent = validatedContracts[log.address.toLowerCase()];
    const spec = AAVE_EVENT_SPECS[log.topics?.[0]?.toLowerCase()];
    const type = spec?.type;
    const protocolId = protocol?.id ?? mappedEvent?.protocolId;
    const registryEntry = protocolId ? resolveProtocol(chainId, protocolId) : undefined;
    if (!protocolId || !registryEntry || !type || !spec ||
      !protocolVersionMatches(spec.version, registryEntry.version)) continue;
    const layout = type === 'reward' ? rewardLayout(protocolId) : undefined;
    const reserve = type === 'reward'
      ? layout === 'aave-v2' ? registryEntry.rewardTokenAddresses[0]?.toLowerCase() : addressFromTopic(log.topics[2])
      : mappedEvent?.reserveKey.toLowerCase() ?? addressFromTopic(log.topics[1]);
    const eventId = exactLogId(chainId, receipt.transactionHash, log);
    const users = type === 'supply' || type === 'borrow'
      ? [dataAddress(log.data, 0), addressFromTopic(log.topics[2])]
      : type === 'withdraw' ? [addressFromTopic(log.topics[2]), addressFromTopic(log.topics[3])]
        : type === 'repay' ? [addressFromTopic(log.topics[2]), addressFromTopic(log.topics[3])]
          : type === 'liquidation' ? [addressFromTopic(log.topics[3])]
            : type === 'interest' ? [addressFromTopic(log.topics[2])]
              : layout === 'aave-v2'
                ? [addressFromTopic(log.topics[1]), addressFromTopic(log.topics[2])]
                : [addressFromTopic(log.topics[1]), addressFromTopic(log.topics[3])];
    const quantity = type === 'supply' || type === 'borrow' || (type === 'reward' && layout !== 'aave-v2')
      ? exactWord(log.data, 1)
      : type === 'interest' ? exactWord(log.data, 1) : exactWord(log.data, 0);
    const debtQuantity = type === 'liquidation' ? exactWord(log.data, 0) : undefined;
    const collateralQuantity = type === 'liquidation' ? exactWord(log.data, 1) : undefined;
    const reserveKey = reserve ?? 'unknown';
    const economicLegs: NonNullable<NeutralDefiAction['economicLegs']> = transferLegs.filter((leg) => {
      const legReserve = leg.mapped?.reserveKey.toLowerCase() ?? leg.contractAddress;
      const sameProtocol = !leg.mapped || leg.mapped.protocolId === protocolId;
      if (!sameProtocol) return false;
      if (type === 'liquidation') {
        const collateral = addressFromTopic(log.topics[1]);
        const debt = addressFromTopic(log.topics[2]);
        return (legReserve === collateral && leg.quantity === collateralQuantity) ||
          (legReserve === debt && leg.quantity === debtQuantity);
      }
      const expectedTokenRole = type === 'borrow' || type === 'repay' ? 'debt_token' : 'protocol_token';
      const expectedTokenDirection = type === 'supply' || type === 'borrow' || type === 'interest' ? 'mint' :
        type === 'withdraw' || type === 'repay' ? 'burn' : undefined;
      if (leg.mapped?.role === expectedTokenRole && expectedTokenDirection === leg.direction &&
        legReserve === reserveKey && (!wallet || leg.from === wallet || leg.to === wallet)) return true;
      if (type === 'reward') {
        const rewardRecipient = layout === 'aave-v2' ? addressFromTopic(log.topics[2]) : addressFromTopic(log.topics[3]);
        const expectedSources = layout === 'aave-v2'
          ? registryEntry.rewardSourceAddresses.map((address) => address.toLowerCase())
          : [log.address.toLowerCase()];
        return mappedEvent?.role === 'reward_controller' && leg.mapped?.role === 'reward' &&
          leg.contractAddress === reserveKey && expectedSources.includes(leg.from) && leg.to === rewardRecipient &&
          leg.direction === 'in' && leg.quantity === quantity && (!wallet || rewardRecipient === wallet);
      }
      if (leg.contractAddress !== reserveKey || leg.quantity !== quantity) return false;
      if (!wallet) return true;
      return leg.from === wallet || leg.to === wallet || users.includes(leg.from) || users.includes(leg.to);
    }).map((leg) => ({
      eventId: leg.eventId,
      kind: leg.mapped?.role === 'protocol_token' || leg.mapped?.role === 'debt_token' || leg.mapped?.role === 'reward'
        ? leg.mapped.role
        : (type === 'reward' ? 'reward' as const :
        leg.direction === 'mint' || leg.direction === 'burn'
          ? type === 'borrow' || type === 'repay' ? 'debt_token' as const : 'protocol_token' as const
          : 'underlying' as const),
      direction: leg.direction,
      contractAddress: leg.contractAddress,
      quantity: leg.quantity,
      from: leg.from,
      to: leg.to
    }));
    const gasUsed = uint256(receipt.gasUsed ?? '');
    const gasPrice = uint256(receipt.effectiveGasPrice ?? '');
    if (wallet && gasUsed != null && gasPrice != null && receipt.from?.toLowerCase() === wallet) {
      const feeQuantity = BigInt(gasUsed) * BigInt(gasPrice);
      if (feeQuantity > 0n) economicLegs.push({
        eventId: `fee:${chainId}:${receipt.transactionHash.toLowerCase()}`,
        kind: 'fee', direction: 'out', contractAddress: 'native', quantity: feeQuantity.toString(),
        from: wallet
      });
    }
    const representedUser = !wallet || users.includes(wallet);
    const count = (kind: NonNullable<NeutralDefiAction['economicLegs']>[number]['kind'], direction: NonNullable<NeutralDefiAction['economicLegs']>[number]['direction']) =>
      economicLegs.filter((leg) => leg.kind === kind && leg.direction === direction).length;
    const hasExpectedLeg = type === 'supply' ? count('underlying', 'out') === 1 && count('protocol_token', 'mint') === 1 :
      type === 'withdraw' ? count('underlying', 'in') === 1 && count('protocol_token', 'burn') === 1 :
        type === 'borrow' ? count('underlying', 'in') === 1 && count('debt_token', 'mint') === 1 :
          type === 'repay' ? count('underlying', 'out') === 1 && count('debt_token', 'burn') === 1 :
            type === 'interest' ? count('protocol_token', 'mint') === 1 :
              type === 'reward' ? count('reward', 'in') === 1 :
                economicLegs.filter((leg) => leg.kind === 'underlying').length === 2;
    const feeComplete = receipt.from?.toLowerCase() !== wallet || count('fee', 'out') === 1;
    const quantitiesComplete = type === 'liquidation'
      ? debtQuantity != null && collateralQuantity != null
      : quantity != null;
    const complete = Boolean(eventId && abiShapeComplete(log, spec, layout) && reserve && users.every(Boolean) &&
      representedUser && quantitiesComplete && hasExpectedLeg && feeComplete);
    const callId = eventId;
    actions.push({
      type, chainId, protocolId, reserveKey,
      quantity: quantity ?? '0',
      ...(type === 'liquidation' ? { debtQuantity, collateralQuantity } : {}),
      transactionHash: receipt.transactionHash.toLowerCase(), callId,
      eventIds: [...(eventId ? [eventId] : []), ...economicLegs
        .filter((leg) => leg.kind !== 'fee').map((leg) => leg.eventId)],
      complete, confidence: complete ? 1 : 0.5, evidenceSource: 'ethereum_log',
      postingAnchorEventId: economicLegs.find((leg) => leg.kind === 'underlying')?.eventId,
      economicLegs,
      ...(complete ? {} : { warnings: ['Exact protocol call boundary, ABI fields, represented user, or economic legs were incomplete.'] })
    });
  }
  return actions;
}

/** Correlate one represented provider leg without guessing among duplicates. */
export function neutralDefiActionForTransfer(
  actions: readonly NeutralDefiAction[],
  match: EvmTransferMatch
): NeutralDefiAction | undefined {
  const contract = match.contractAddress?.toLowerCase();
  const from = match.from?.toLowerCase();
  const to = match.to?.toLowerCase();
  const rawQuantity = match.rawQuantity == null ? undefined : providerBaseUnits(match.rawQuantity);
  if (!contract || !from || !to || rawQuantity == null) return undefined;
  const matches = actions.filter((action) => action.complete && action.economicLegs?.filter((leg) =>
    leg.contractAddress === contract && leg.from === from && leg.to === to &&
    leg.quantity === rawQuantity &&
    (match.direction === 'transfer_in' ? leg.direction === 'in' : leg.direction === 'out')
  ).length === 1);
  return matches.length === 1 ? matches[0] : undefined;
}

export interface ProviderDefiLeg {
  eventId?: string;
  reserveKey?: string;
  quantity?: string;
}

/** Provider labels may create neutral evidence, never a tax conclusion. */
export function groupProviderDefiAction(input: {
  chainId: number;
  transactionHash: string;
  protocolId?: string;
  action?: NeutralDefiActionType;
  legs: readonly ProviderDefiLeg[];
}): NeutralDefiAction | null {
  if (!input.action) return null;
  const supported = input.protocolId ? resolveProtocol(input.chainId, input.protocolId) : undefined;
  const exactLegs = input.legs.filter((leg) => leg.eventId);
  const reserves = new Set(exactLegs.map((leg) => leg.reserveKey).filter(Boolean));
  // A provider category plus transfer legs is useful provenance but is not an
  // exact protocol event. Receipt-log decoding is the only complete path.
  const complete = false;
  return {
    type: input.action, chainId: input.chainId,
    protocolId: input.protocolId ?? 'unsupported',
    reserveKey: reserves.size === 1 ? [...reserves][0]! : 'unknown',
    quantity: exactLegs.length === 1 && uint256(exactLegs[0].quantity ?? '') != null
      ? uint256(exactLegs[0].quantity!)!
      : '0',
    transactionHash: input.transactionHash.toLowerCase(),
    eventIds: exactLegs.map((leg) => leg.eventId!), complete,
    confidence: supported && exactLegs.length === input.legs.length && reserves.size === 1 ? 0.6 : 0.4,
    evidenceSource: 'moralis',
    warnings: complete ? undefined : ['Provider classification lacks complete exact protocol event evidence.']
  };
}

function addressFromTopic(topic?: string): string | null {
  const clean = topic?.replace(/^0x/, '');
  return clean && clean.length === 64 ? `0x${clean.slice(24).toLowerCase()}` : null;
}
function uint256(hex: string): string | null {
  try {
    const clean = hex.replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{1,64}$/.test(clean)) return null;
    return BigInt(`0x${clean}`).toString();
  } catch { return null; }
}
function providerBaseUnits(value: string): string | null {
  try {
    const normalized = value.trim();
    if (/^0x[0-9a-f]{1,64}$/i.test(normalized)) return BigInt(normalized).toString();
    if (/^[0-9]+$/.test(normalized)) return BigInt(normalized).toString();
    return null;
  } catch { return null; }
}
function amountFor(raw: string, contract: string): number | undefined {
  const decimals = TOKEN_META[contract]?.decimals;
  if (decimals == null) return undefined;
  const amount = Number(raw) / 10 ** decimals;
  return Number.isFinite(amount) ? amount : undefined;
}

function decodeTransferLogs(receipt: EvmTxReceipt, walletAddress: string, extraContracts: Record<string, KnownContract>): EvmDecodeResult[] {
  const wallet = walletAddress.toLowerCase();
  const known = { ...KNOWN_PROTOCOL_CONTRACTS, ...Object.fromEntries(Object.entries(extraContracts).map(([k, v]) => [k.toLowerCase(), v])) };
  const results: EvmDecodeResult[] = [];
  for (const log of receipt.logs ?? []) {
    const topic = log.topics?.[0]?.toLowerCase();
    // ERC-20 has 3 topics. ERC-721 shares topic0 but has 4; avoid decoding tokenId as fungible amount.
    if (topic !== ERC_TRANSFER_TOPIC || log.topics.length !== 3) continue;
    const from = addressFromTopic(log.topics[1]);
    const to = addressFromTopic(log.topics[2]);
    const rawAmount = uint256(log.data);
    if (!from || !to || rawAmount == null || (from !== wallet && to !== wallet)) continue;
    const contract = log.address.toLowerCase();
    const metadata = TOKEN_META[contract];
    const base = {
      asset: metadata?.symbol,
      amount: amountFor(rawAmount, contract),
      rawAmount,
      contractAddress: contract,
      counterpartyAddress: to === wallet ? from : to,
      confidence: 'high' as const
    };
    if (to === wallet && known[from]?.role === 'rewards_source') {
      results.push({ ...base, type: 'income', notes: `${known[from].label} — possible rewards distribution` });
      continue;
    }
    if (from === wallet && known[to]?.role === 'deposit_target') {
      results.push({ ...base, type: 'defi_deposit', notes: `Deposit to ${known[to].label}` });
      continue;
    }
    if (from === wallet && known[to]?.role === 'router') {
      results.push({ ...base, type: 'trade', notes: `Swap via ${known[to].label}`, confidence: 'medium' });
      continue;
    }
    results.push({ ...base, type: to === wallet ? 'transfer_in' : 'transfer_out' });
  }
  return results;
}

export function decodeEvmReceipt(receipt: EvmTxReceipt, walletAddress: string, extraContracts: Record<string, KnownContract> = {}): EvmDecodeResult | null {
  return decodeTransferLogs(receipt, walletAddress, extraContracts)[0] ?? null;
}

/** Decode only the receipt leg represented by one Alchemy transfer row. */
export function decodeEvmReceiptForTransfer(
  receipt: EvmTxReceipt,
  walletAddress: string,
  match: EvmTransferMatch,
  extraContracts: Record<string, KnownContract> = {}
): EvmDecodeResult | null {
  const contract = match.contractAddress?.toLowerCase();
  const from = match.from?.toLowerCase();
  const to = match.to?.toLowerCase();
  return decodeTransferLogs(receipt, walletAddress, extraContracts).find((decoded) => {
    if (contract && decoded.contractAddress !== contract) return false;
    if (decoded.type === 'transfer_in' || decoded.type === 'income') {
      if (match.direction !== 'transfer_in') return false;
      return (!from || decoded.counterpartyAddress === from) && (!to || to === walletAddress.toLowerCase());
    }
    if (match.direction !== 'transfer_out') return false;
    return (!to || decoded.counterpartyAddress === to) && (!from || from === walletAddress.toLowerCase());
  }) ?? null;
}

export async function fetchEvmTransactionReceipt(
  rpcUrl: string,
  txHash: string,
  headers: HeadersInit = { 'Content-Type': 'application/json' }
): Promise<EvmTxReceipt | null> {
  try {
    const response = await fetch(rpcUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }) });
    if (!response.ok) return null;
    const json = await response.json();
    const result = json?.result;
    if (!result || !Array.isArray(result.logs)) return null;
    return {
      transactionHash: result.transactionHash,
      from: result.from,
      to: result.to,
      gasUsed: result.gasUsed,
      effectiveGasPrice: result.effectiveGasPrice,
      logs: result.logs
    };
  } catch { return null; }
}

export async function decodeEvmTxByHash(
  rpcUrl: string,
  txHash: string,
  walletAddress: string,
  extraContracts?: Record<string, KnownContract>,
  headers: HeadersInit = { 'Content-Type': 'application/json' }
): Promise<EvmDecodeResult | null> {
  const receipt = await fetchEvmTransactionReceipt(rpcUrl, txHash, headers);
  return receipt ? decodeEvmReceipt(receipt, walletAddress, extraContracts) : null;
}

export function isKnownProtocolContract(address: string, extraContracts: Record<string, KnownContract> = {}): KnownContract | null {
  return KNOWN_PROTOCOL_CONTRACTS[address.toLowerCase()] ?? extraContracts[address.toLowerCase()] ?? null;
}
