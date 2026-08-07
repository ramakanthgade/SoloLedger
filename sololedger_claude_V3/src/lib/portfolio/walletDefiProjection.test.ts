import { describe, expect, it } from 'vitest';
import type { DefiPositionSnapshot, ProtocolId } from '@/lib/defi/types';
import { projectManifestSelectedWalletDefi } from './walletDefiProjection';

const ADDRESS = `0x${'1'.repeat(40)}`;
const EMPTY_ADDRESS = `0x${'2'.repeat(40)}`;
const SCOPE = `wallet:evm:${ADDRESS}`;
const EMPTY_SCOPE = `wallet:evm:${EMPTY_ADDRESS}`;
const PROTOCOLS: ProtocolId[] = ['aave-v2-ethereum', 'aave-v3-ethereum', 'spark-v1-ethereum'];
const USDC = `0x${'3'.repeat(40)}`;
const RECEIPT = `0x${'4'.repeat(40)}`;
const DEBT = `0x${'5'.repeat(40)}`;

function snapshots(scope: string): DefiPositionSnapshot[] {
  return PROTOCOLS.map((protocolId) => ({
    snapshotId: `${scope}:${protocolId}:1`, generation: 1, accountIdentityScope: scope,
    protocolId, chainId: 1, status: 'complete', capturedAt: 1, blockNumber: 1,
    evidence: [{ provider: 'ethereum-rpc', status: 'complete', blockNumber: 1, detail: 'fixture' }]
  }));
}

function authority(scope: string) {
  const address = scope.slice('wallet:evm:'.length);
  return {
    snapshotId: `${scope}:custody`, generation: 1, scopeId: `wallet:evm:1:${address}`,
    authorityKind: 'rpc' as const, authorityClass: 'wallet_balance' as const, accountClass: 'wallet' as const,
    coveredAccountClasses: ['wallet' as const], asOf: 1, capturedAt: 1, sourceIdentityId: `ethereum:${address}`,
    endpointProof: { authorityKind: 'rpc' as const, provider: 'fixture', operation: 'fixture', parametersClass: 'fixture', requestedAccountClasses: ['wallet' as const], provenAccountClasses: ['wallet' as const], exhaustiveBalances: true },
    status: 'complete' as const
  };
}

function manifest(scope: string) {
  const custody = authority(scope);
  return {
    accountIdentityScope: scope, custodyScopeId: custody.scopeId, custodySnapshotId: custody.snapshotId,
    custodyGeneration: 1, custodyAsOf: 1, blockNumber: 1, capturedAt: 1,
    protocolSnapshotIds: Object.fromEntries(PROTOCOLS.map((protocolId) => [
      protocolId, `${scope}:${protocolId}:1`
    ])) as Record<ProtocolId, string>
  };
}

describe('manifest-selected wallet DeFi projection', () => {
  it('uses the same scoped result for aggregate Dashboard/Data Health and filtered Connections inputs', () => {
    const allSnapshots = [...snapshots(SCOPE), ...snapshots(EMPTY_SCOPE)];
    const v3 = `${SCOPE}:aave-v3-ethereum:1`;
    const token = (contractAddress: string, symbol: string) => ({ chainId: 1 as const, contractAddress, symbol, decimals: 6 });
    const rows = [{
      id: 'supply', snapshotId: v3, protocolId: 'aave-v3-ethereum' as const, reserveKey: USDC,
      role: 'supply' as const, underlying: token(USDC, 'USDC'), protocolToken: token(RECEIPT, 'aUSDC'),
      quantity: 100, rawQuantity: '100000000', isCollateral: true
    }, {
      id: 'debt', snapshotId: v3, protocolId: 'aave-v3-ethereum' as const, reserveKey: USDC,
      role: 'debt' as const, underlying: token(USDC, 'USDC'), protocolToken: token(DEBT, 'variableDebtUSDC'),
      quantity: 90, rawQuantity: '90000000', debtRateMode: 'variable' as const
    }];
    const input = {
      custody: [
        { id: 'liquid', scopeId: SCOPE, chainId: 1, contractAddress: USDC, symbol: 'USDC', quantity: 50, value: 50 },
        { id: 'receipt', scopeId: SCOPE, chainId: 1, contractAddress: RECEIPT, symbol: 'aUSDC', quantity: 100, value: 100 }
      ],
      snapshots: allSnapshots, rows,
      custodyAuthoritySnapshots: [authority(SCOPE), authority(EMPTY_SCOPE)],
      refreshManifests: [manifest(SCOPE), manifest(EMPTY_SCOPE)],
      prices: new Map([[USDC, 1]]), reportingCurrency: 'USD', enabled: true, now: 1
    };

    const aggregate = projectManifestSelectedWalletDefi(input).projection;
    const connection = projectManifestSelectedWalletDefi({
      ...input, scopeFilter: new Set([`wallet:evm:1:${ADDRESS}`])
    }).projection;
    expect(aggregate).toMatchObject({ status: 'complete', netWorth: 60 });
    expect(connection.assets).toEqual(aggregate.assets.filter((row) => row.scopeId === SCOPE));
    expect(connection.liabilities).toEqual(aggregate.liabilities.filter((row) => row.scopeId === SCOPE));
    expect(connection.netWorth).toBe(60);
  });

  it('retains a manifest-selected exited wallet scope and reports complete zero net worth', () => {
    const output = projectManifestSelectedWalletDefi({
      custody: [], snapshots: snapshots(EMPTY_SCOPE), rows: [],
      custodyAuthoritySnapshots: [authority(EMPTY_SCOPE)], refreshManifests: [manifest(EMPTY_SCOPE)],
      reportingCurrency: 'USD', enabled: true, now: 1,
      scopeFilter: new Set([`wallet:evm:1:${EMPTY_ADDRESS}`])
    }).projection;
    expect(output).toMatchObject({ status: 'complete', netWorth: 0, assets: [], liabilities: [] });
  });
});
