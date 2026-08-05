export type ProtocolId = 'aave-v2-ethereum' | 'aave-v3-ethereum' | 'spark-v1-ethereum';
export type PositionRole = 'supply' | 'debt';
export type DebtRateMode = 'stable' | 'variable';
export type PositionSnapshotStatus = 'complete' | 'partial' | 'unsupported';

export interface ProtocolTokenIdentity {
  chainId: 1;
  contractAddress: string;
  symbol: string;
  decimals: number;
}

export interface PositionValueEvidence {
  currency: 'USD';
  value: number;
  observedAt: number;
  provider: string;
}

interface PositionRowBase {
  id: string;
  snapshotId: string;
  protocolId: ProtocolId;
  reserveKey: string;
  underlying: ProtocolTokenIdentity;
  quantity: number;
  rawQuantity: string;
  valueEvidence?: PositionValueEvidence;
}

export interface SupplyPositionRow extends PositionRowBase {
  role: 'supply';
  isCollateral: boolean;
  protocolToken: ProtocolTokenIdentity;
}

export interface DebtPositionRow extends PositionRowBase {
  role: 'debt';
  debtRateMode: DebtRateMode;
  protocolToken: ProtocolTokenIdentity;
}

export type DefiPositionRow = SupplyPositionRow | DebtPositionRow;

export interface PositionEvidenceOutcome {
  provider: 'moralis' | 'ethereum-rpc';
  status: 'complete' | 'partial' | 'unavailable';
  blockNumber?: number;
  detail: string;
}

export interface DefiPositionSnapshot {
  snapshotId: string;
  generation: number;
  accountIdentityScope: string;
  protocolId: ProtocolId;
  chainId: number;
  status: PositionSnapshotStatus;
  capturedAt: number;
  blockNumber?: number;
  evidence: PositionEvidenceOutcome[];
  warnings?: string[];
  supersedesSnapshotId?: string;
  restoredAt?: number;
}

export type DefiPositionRequest = {
  chainId: number;
  protocolId: string;
  address: string;
};

export type DefiPositionResult =
  | { status: 'unsupported'; chainId: number; protocolId: string; rows: []; warnings: string[] }
  | { status: 'complete' | 'partial'; chainId: 1; protocolId: ProtocolId; blockNumber?: number; rows: DefiPositionRow[]; evidence: PositionEvidenceOutcome[]; warnings: string[] };

export type NeutralDefiActionType = 'supply' | 'withdraw' | 'borrow' | 'repay' | 'interest' | 'reward' | 'liquidation';
export interface NeutralDefiAction {
  type: NeutralDefiActionType;
  protocolId: ProtocolId;
  reserveKey: string;
  quantity: number;
  transactionHash: string;
  eventIds: string[];
  complete: boolean;
}

export function accountIdentityScope(address: string): string {
  const normalized = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error('Invalid Ethereum account address.');
  return `wallet:evm:${normalized}`;
}

/** Join pre-B1 chain-scoped wallet authority to the canonical EVM account scope. */
export function canonicalDefiAccountScope(scope: string): string {
  const normalized = scope.trim().toLowerCase();
  const chainScoped = /^wallet:evm:1:(0x[0-9a-f]{40})$/.exec(normalized);
  if (chainScoped) return `wallet:evm:${chainScoped[1]}`;
  return normalized;
}
