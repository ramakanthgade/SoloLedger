import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  getCoinGeckoRewardCount,
  syncCoinGeckoRewardRegistry
} from '@/lib/assets/coingeckoRewardRegistry';
import {
  getAllocationCount,
  syncCoinGeckoAllocations
} from '@/lib/assets/coingeckoAllocations';
import {
  getBlockworksCount,
  syncBlockworksRegistry
} from '@/lib/assets/blockworksRegistry';

type RegistryKey = 'rewardTokens' | 'allocations' | 'blockworks';
interface Status { count: number; syncing: boolean; message: string; error: boolean }

export function AddressRegistrySettingsSection({ coingeckoApiKey }: { coingeckoApiKey?: string }) {
  const [statuses, setStatuses] = useState<Record<RegistryKey, Status>>(() => ({
    rewardTokens: { count: getCoinGeckoRewardCount(), syncing: false, message: '', error: false },
    allocations: { count: getAllocationCount(), syncing: false, message: '', error: false },
    blockworks: { count: getBlockworksCount(), syncing: false, message: '', error: false }
  }));

  const setSyncing = (key: RegistryKey) => setStatuses((current) => ({
    ...current,
    [key]: { ...current[key], syncing: true, message: '', error: false }
  }));
  const finish = (key: RegistryKey, count: number, message: string, error = false) => setStatuses((current) => ({
    ...current,
    [key]: { count, syncing: false, message, error }
  }));

  const syncRewards = async () => {
    setSyncing('rewardTokens');
    try {
      const result = await syncCoinGeckoRewardRegistry(coingeckoApiKey, { force: true });
      finish('rewardTokens', result.entriesCount, result.message);
    } catch (error) {
      finish('rewardTokens', getCoinGeckoRewardCount(), error instanceof Error ? error.message : 'Sync failed', true);
    }
  };
  const syncAllocations = async () => {
    if (!coingeckoApiKey) return;
    setSyncing('allocations');
    try {
      const result = await syncCoinGeckoAllocations(coingeckoApiKey, { force: true });
      finish('allocations', result.totalWallets, result.message);
    } catch (error) {
      finish('allocations', getAllocationCount(), error instanceof Error ? error.message : 'Sync failed', true);
    }
  };
  const syncBlockworks = async () => {
    setSyncing('blockworks');
    try {
      const result = await syncBlockworksRegistry();
      finish('blockworks', result.entriesCount, result.message);
    } catch (error) {
      finish('blockworks', getBlockworksCount(), error instanceof Error ? error.message : 'Sync failed', true);
    }
  };

  const rows: Array<{ key: RegistryKey; label: string; unit: string; action: () => Promise<void>; disabled?: boolean }> = [
    { key: 'rewardTokens', label: 'Reward tokens (CoinGecko)', unit: 'tokens', action: syncRewards },
    { key: 'allocations', label: 'Allocation wallets (CoinGecko Pro)', unit: 'wallets', action: syncAllocations, disabled: !coingeckoApiKey },
    { key: 'blockworks', label: 'Blockworks Transparency', unit: 'addresses', action: syncBlockworks }
  ];

  return (
    <Card>
      <CardHeader><CardTitle>Address registries</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs leading-relaxed text-low">
          Sync public token and project-wallet metadata used to suggest income classifications. Dynamic matches are always sent to Review; registry requests never include your wallet addresses.
        </p>
        {!coingeckoApiKey && <p className="text-xs text-warn">A CoinGecko Pro key is required only for allocation-wallet data.</p>}
        <div className="space-y-3">
          {rows.map((row) => {
            const status = statuses[row.key];
            return (
              <div key={row.key} className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-mid">{row.label}</p>
                  <p className="text-xs text-low">{status.count} {row.unit}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => void row.action()} disabled={status.syncing || row.disabled}>
                  {status.syncing ? 'Syncing…' : 'Sync'}
                </Button>
              </div>
            );
          })}
        </div>
        {Object.entries(statuses).filter(([, status]) => status.message).map(([key, status]) => (
          <p key={key} role={status.error ? 'alert' : 'status'} className={`text-xs ${status.error ? 'text-loss' : 'text-gain'}`}>
            {status.message}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}
