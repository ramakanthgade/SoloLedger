import { useEffect } from 'react';
import { DashboardTab } from '@/components/dashboard/DashboardTab';
import { TabNavProvider } from '@/lib/tabNav';
import type { HoldingsPerfPhase, HoldingsPerfProtocol } from './holdingsPerfProbe';

const EXPECTED_COUNTS: Record<HoldingsPerfPhase, number> = {
  initial: 30_000,
  'live-update': 30_001
};
const EXPECTED_BTC_QUANTITIES: Record<HoldingsPerfPhase, number> = {
  initial: 15_000,
  'live-update': 15_001
};

function pendingPhase(protocol: HoldingsPerfProtocol): HoldingsPerfPhase | undefined {
  if (protocol.isPending('live-update')) return 'live-update';
  if (protocol.isPending('initial')) return 'initial';
  return undefined;
}

export function HoldingsPerfDashboard({ protocol }: { protocol: HoldingsPerfProtocol }) {
  useEffect(() => {
    const completeWhenProjectionIsCommitted = () => {
      const phase = pendingPhase(protocol);
      if (!phase) return false;
      const expectedTransactionCount = EXPECTED_COUNTS[phase];
      const expectedBtcQuantity = EXPECTED_BTC_QUANTITIES[phase];
      const generation = document.querySelector('[data-testid="dashboard-holdings-generation"]');
      if (
        generation?.getAttribute('data-transaction-count') === String(expectedTransactionCount) &&
        generation.getAttribute('data-btc-quantity') === String(expectedBtcQuantity)
      ) {
        protocol.completeAfterPaint(phase, expectedTransactionCount);
        return true;
      }
      return false;
    };
    completeWhenProjectionIsCommitted();
    const observer = new MutationObserver(() => {
      completeWhenProjectionIsCommitted();
    });
    observer.observe(document.getElementById('root')!, {
      attributes: true,
      attributeFilter: ['data-transaction-count', 'data-btc-quantity'],
      childList: true,
      subtree: true
    });
    return () => observer.disconnect();
  }, [protocol]);

  return (
    <TabNavProvider value={{ goToImport: () => {}, goTo: () => {} }}>
      <DashboardTab instrumentation={{
        measureChartPreparation: protocol.measureChartPrefix
      }} />
    </TabNavProvider>
  );
}
