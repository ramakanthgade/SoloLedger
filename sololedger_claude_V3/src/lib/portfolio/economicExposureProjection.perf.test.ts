import { describe, expect, it } from 'vitest';
import type { EconomicExposureProjectionMetrics } from './economicExposureProjection';
import { projectManifestSelectedWalletDefi } from './walletDefiProjection';
import type { DefiPositionRow, DefiPositionSnapshot, ProtocolId, WalletDefiRefreshManifest } from '@/lib/defi/types';
import type { AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';

const PROTOCOLS: ProtocolId[] = ['aave-v2-ethereum', 'aave-v3-ethereum', 'spark-v1-ethereum'];

describe('economic exposure indexed projection performance', () => {
  it('visits accumulated generations and rows once across multiple wallets', () => {
    const walletCount = 30;
    const generations = 150;
    const snapshots: DefiPositionSnapshot[] = [];
    const rows: DefiPositionRow[] = [];
    const custody = [];
    const authorities: AuthoritySnapshotRow[] = [];
    const manifests: WalletDefiRefreshManifest[] = [];
    const prices = new Map<string, number>();

    for (let wallet = 0; wallet < walletCount; wallet += 1) {
      const address = `0x${wallet.toString(16).padStart(40, '0')}`;
      const scope = `wallet:evm:${address}`;
      const custodyScope = `wallet:evm:1:${address}`;
      const custodySnapshotId = `custody:${wallet}`;
      custody.push({ id: `liquid:${wallet}`, scopeId: scope, chainId: 1, symbol: 'ETH', quantity: 10, value: 10 });
      authorities.push({
        snapshotId: custodySnapshotId, generation: 1, scopeId: custodyScope,
        authorityKind: 'rpc', authorityClass: 'wallet_balance', accountClass: 'wallet',
        coveredAccountClasses: ['wallet'], asOf: generations - 1, capturedAt: generations - 1,
        sourceIdentityId: `ethereum:${address}`, status: 'complete',
        endpointProof: { authorityKind: 'rpc', provider: 'fixture', operation: 'fixture', parametersClass: 'fixture', requestedAccountClasses: ['wallet'], provenAccountClasses: ['wallet'], exhaustiveBalances: true }
      });
      const protocolSnapshotIds = {} as Record<ProtocolId, string>;
      for (const protocolId of PROTOCOLS) {
        const reserve = `0x${(wallet * PROTOCOLS.length + PROTOCOLS.indexOf(protocolId) + 1).toString(16).padStart(40, '0')}`;
        prices.set(reserve, 1);
        for (let generation = 1; generation <= generations; generation += 1) {
          const snapshotId = `${scope}:${protocolId}:${generation}`;
          snapshots.push({
            snapshotId, generation, accountIdentityScope: scope, protocolId, chainId: 1,
            status: generation === generations ? 'partial' : 'complete', capturedAt: generation, blockNumber: 1,
            evidence: [{ provider: 'ethereum-rpc', status: 'complete', blockNumber: 1, detail: 'fixture' }]
          });
          rows.push({
            id: `${snapshotId}:debt`, snapshotId, protocolId, reserveKey: reserve, role: 'debt',
            underlying: { chainId: 1, contractAddress: reserve, symbol: 'USD', decimals: 6 },
            protocolToken: { chainId: 1, contractAddress: reserve, symbol: 'variableDebtUSD', decimals: 6 },
            quantity: generation, rawQuantity: String(generation * 1_000_000), debtRateMode: 'variable'
          });
          if (generation === generations - 1) protocolSnapshotIds[protocolId] = snapshotId;
        }
      }
      manifests.push({
        accountIdentityScope: scope, custodyScopeId: custodyScope, custodySnapshotId,
        custodyGeneration: 1, custodyAsOf: generations - 1, blockNumber: 1, capturedAt: generations - 1,
        protocolSnapshotIds
      });
    }

    const metrics: EconomicExposureProjectionMetrics = {
      custodyVisits: 0, snapshotRowVisits: 0, snapshotVisits: 0,
      custodyAuthorityVisits: 0, manifestVisits: 0
    };
    const startedAt = performance.now();
    const output = projectManifestSelectedWalletDefi({
      custody, snapshots, rows, custodyAuthoritySnapshots: authorities, refreshManifests: manifests,
      prices, reportingCurrency: 'USD', enabled: true, metrics
    }).projection;
    const elapsed = performance.now() - startedAt;

    expect(output.status).toBe('partial');
    expect(output.liabilities).toHaveLength(walletCount * PROTOCOLS.length);
    expect(output.liabilities.every((row) => row.quantity === generations)).toBe(true);
    expect(metrics).toEqual({
      custodyVisits: custody.length,
      snapshotRowVisits: rows.length,
      snapshotVisits: snapshots.length,
      custodyAuthorityVisits: authorities.length,
      manifestVisits: manifests.length
    });
    expect(elapsed).toBeLessThan(1_000);
  });
});
