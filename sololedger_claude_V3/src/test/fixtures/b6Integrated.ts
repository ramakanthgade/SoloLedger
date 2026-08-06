import type { DefiPositionRow, DefiPositionSnapshot, NeutralDefiAction } from '@/lib/defi/types';
import type { SafetyDecisionRow, SafetyState } from '@/lib/safety/types';
import type { ClassificationEvidence, Transaction } from '@/types/transaction';
import { assetSubjectKey } from '@/lib/safety/canonicalAssets';

export const B6_NOW = 1_785_945_600_000;
export const B6_EVM_ADDRESS = `0x${'1'.repeat(40)}`;
export const B6_SECOND_EVM_ADDRESS = `0x${'2'.repeat(40)}`;
export const B6_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
export const B6_AUSDC = '0xbcca60bb61934080951369a648fb03df4f96263c';
export const B6_DEBT_USDC = '0x72e95b8931767c79ba4ee721e2dfd084399483da';
export const B6_WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
export const B6_AAVE_WBTC = '0x5ee5bf7ae06d1be5997a1a72006fe6c607eC6DE8'.toLowerCase();
export const B6_SPARK_WBTC = '0x4197ba364ae6698015ae5c1468f54087602715b2';

export function b6Transaction(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    timestamp: B6_NOW,
    type: 'transfer_in',
    asset: 'USDC',
    amount: 25,
    fiatCurrency: 'USD',
    fiatValue: 25,
    source: 'rpc',
    flags: [],
    isInternalTransfer: false,
    ...overrides
  };
}

export const b6WalletSources = [
  { id: `ethereum:${B6_EVM_ADDRESS}`, chain: 'ethereum', address: B6_EVM_ADDRESS, lastSyncedAt: B6_NOW, txCount: 1 },
  { id: `polygon:${B6_EVM_ADDRESS}`, chain: 'polygon', address: B6_EVM_ADDRESS.toUpperCase(), lastSyncedAt: B6_NOW, txCount: 1 },
  { id: `ethereum:${B6_SECOND_EVM_ADDRESS}`, chain: 'ethereum', address: B6_SECOND_EVM_ADDRESS, lastSyncedAt: B6_NOW, txCount: 1 }
];

export const b6SafetyDecisions: SafetyDecisionRow[] = (
  ['trusted', 'high_confidence_spam', 'unverified', 'user_hidden', 'user_visible'] satisfies SafetyState[]
).map((state, index) => ({
  subjectKey: assetSubjectKey('ethereum', `0x${String(index + 3).repeat(40)}`),
  state,
  updatedAt: B6_NOW + index,
  origin: state === 'user_hidden' || state === 'user_visible' ? 'user' : 'automatic',
  evidenceIds: [`evidence-${index}`],
  ...(state === 'user_visible' ? { previousAutomaticState: 'high_confidence_spam' as const } : {})
}));

const event = {
  chain: 'ethereum',
  txHash: `0x${'a'.repeat(64)}`,
  assetKey: B6_USDC,
  indexKind: 'log' as const,
  index: '7',
  sender: B6_EVM_ADDRESS,
  recipient: B6_SECOND_EVM_ADDRESS,
  quantity: '25'
};

export const b6TransferTransactions = {
  exactOut: b6Transaction('exact-out', {
    type: 'transfer_out', chain: 'ethereum', txHash: event.txHash, contractAddress: B6_USDC,
    walletAddress: B6_EVM_ADDRESS, outboundInitiation: 'wallet_initiated', onchainTransferEvent: event
  }),
  exactIn: b6Transaction('exact-in', {
    chain: 'ethereum', txHash: event.txHash, contractAddress: B6_USDC,
    walletAddress: B6_SECOND_EVM_ADDRESS, onchainTransferEvent: event
  }),
  suggestedOut: b6Transaction('suggested-out', {
    type: 'transfer_out', timestamp: B6_NOW + 100, chain: 'ethereum', contractAddress: B6_USDC,
    walletAddress: B6_EVM_ADDRESS, outboundInitiation: 'wallet_initiated'
  }),
  suggestedIn: b6Transaction('suggested-in', {
    timestamp: B6_NOW + 200, chain: 'ethereum', contractAddress: B6_USDC,
    walletAddress: B6_SECOND_EVM_ADDRESS
  }),
  spoofedOut: b6Transaction('spoofed-out', {
    type: 'transfer_out', timestamp: B6_NOW + 300, chain: 'ethereum', contractAddress: B6_USDC,
    walletAddress: B6_EVM_ADDRESS, outboundInitiation: 'spoofed_outbound_log'
  })
};

export const b6ClassificationEvidence: ClassificationEvidence[] = [
  {
    type: 'income', category: 'other_income', origin: 'rule', confidence: 0.95,
    ruleId: 'rule:generic-income', ruleVersion: '1', observedAt: B6_NOW, allowlisted: true,
    explanation: 'Allowlisted generic income rule.'
  },
  {
    type: 'income', category: 'staking_reward', origin: 'provider', confidence: 0.99,
    ruleId: 'provider:staking', ruleVersion: '1', observedAt: B6_NOW + 1,
    explanation: 'Exact provider staking evidence.'
  },
  {
    type: 'income', category: 'airdrop', origin: 'suggestion', confidence: 1,
    ruleId: 'suggestion:airdrop', ruleVersion: '1', observedAt: B6_NOW + 2,
    explanation: 'Review-only airdrop suggestion.'
  }
];

export const b6DefiSnapshot: DefiPositionSnapshot = {
  snapshotId: 'b6-defi', generation: 1, accountIdentityScope: `wallet:evm:${B6_EVM_ADDRESS}`,
  protocolId: 'aave-v3-ethereum', chainId: 1, status: 'complete', capturedAt: B6_NOW,
  blockNumber: 23_100_000,
  evidence: [{ provider: 'ethereum-rpc', status: 'complete', blockNumber: 23_100_000, detail: 'sanitized integrated fixture' }]
};

const positionBase = {
  snapshotId: b6DefiSnapshot.snapshotId,
  protocolId: b6DefiSnapshot.protocolId,
  reserveKey: B6_USDC,
  underlying: { chainId: 1 as const, contractAddress: B6_USDC, symbol: 'USDC', decimals: 6 },
  protocolToken: { chainId: 1 as const, contractAddress: B6_AUSDC, symbol: 'aUSDC', decimals: 6 }
};

export const b6DefiRows: DefiPositionRow[] = [
  {
    ...positionBase, id: 'b6-supply', role: 'supply', quantity: 100_000,
    rawQuantity: '100000000000', isCollateral: true,
    valueEvidence: { currency: 'USD', value: 100_000, observedAt: B6_NOW, provider: 'b6-captured-fixture' }
  },
  {
    ...positionBase, id: 'b6-debt', role: 'debt', quantity: 90_005, rawQuantity: '90005000000',
    debtRateMode: 'variable', protocolToken: { ...positionBase.protocolToken, contractAddress: B6_DEBT_USDC, symbol: 'variableDebtUSDC' },
    valueEvidence: { currency: 'USD', value: 90_005, observedAt: B6_NOW, provider: 'b6-captured-fixture' }
  }
];

export const b6SparkSnapshot: DefiPositionSnapshot = {
  ...b6DefiSnapshot, snapshotId: 'b6-spark-defi', protocolId: 'spark-v1-ethereum'
};

export const b6WbtcDefiRows: DefiPositionRow[] = [
  {
    id: 'b6-aave-wbtc', snapshotId: b6DefiSnapshot.snapshotId, protocolId: b6DefiSnapshot.protocolId,
    reserveKey: B6_WBTC, role: 'supply', quantity: 0.1, rawQuantity: '10000000', isCollateral: true,
    underlying: { chainId: 1, contractAddress: B6_WBTC, symbol: 'WBTC', decimals: 8 },
    protocolToken: { chainId: 1, contractAddress: B6_AAVE_WBTC, symbol: 'aEthWBTC', decimals: 8 },
    valueEvidence: { currency: 'USD', value: 6_000, observedAt: B6_NOW, provider: 'b6-captured-fixture' }
  },
  {
    id: 'b6-spark-wbtc', snapshotId: b6SparkSnapshot.snapshotId, protocolId: b6SparkSnapshot.protocolId,
    reserveKey: B6_WBTC, role: 'supply', quantity: 0.2, rawQuantity: '20000000', isCollateral: false,
    underlying: { chainId: 1, contractAddress: B6_WBTC, symbol: 'WBTC', decimals: 8 },
    protocolToken: { chainId: 1, contractAddress: B6_SPARK_WBTC, symbol: 'spWBTC', decimals: 8 },
    valueEvidence: { currency: 'USD', value: 12_000, observedAt: B6_NOW, provider: 'b6-captured-fixture' }
  }
];

export function b6DefiAction(type: NeutralDefiAction['type'], overrides: Partial<NeutralDefiAction> = {}): NeutralDefiAction {
  return {
    type, chainId: 1, protocolId: 'aave-v3-ethereum', reserveKey: B6_USDC,
    quantity: '1000000', transactionHash: `0x${'b'.repeat(64)}`,
    eventIds: [`${type}-event`], complete: true, confidence: 1, evidenceSource: 'ethereum_log',
    ...overrides
  };
}
