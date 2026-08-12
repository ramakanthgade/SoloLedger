import { useEffect } from 'react';
import { DashboardTab } from '@/components/dashboard/DashboardTab';
import { TabNavProvider } from '@/lib/tabNav';
import type { HoldingsPerfPhase, HoldingsPerfProtocol } from './holdingsPerfProbe';

function pendingPhase(protocol: HoldingsPerfProtocol): HoldingsPerfPhase | undefined {
  if (protocol.isPending('live-update')) return 'live-update';
  if (protocol.isPending('initial')) return 'initial';
  return undefined;
}

export function HoldingsPerfDashboard({ protocol }: { protocol: HoldingsPerfProtocol }) {
  useEffect(() => {
    const timer = window.setInterval(() => {
      const phase = pendingPhase(protocol);
      if (!phase) return;
      const generation = document.querySelector('[data-testid="dashboard-holdings-generation"]');
      const transactionCount = Number(generation?.getAttribute('data-transaction-count'));
      const expected = phase === 'initial' ? 30_000 : 30_001;
      if (transactionCount === expected) protocol.completeAfterPaint(phase, transactionCount);
    }, 10);
    return () => window.clearInterval(timer);
  }, [protocol]);

  return (
    <TabNavProvider value={{ goToImport: () => {}, goTo: () => {} }}>
      <DashboardTab instrumentation={{
        measureChartPreparation: protocol.measureChartPrefix,
        onProjectionStart: (transactionCount) => {
          const phase = pendingPhase(protocol);
          if (phase === 'live-update' && transactionCount === 30_001) protocol.begin(phase);
        },
        onSnapshotCommit: ({ transactionCount }) => {
          const phase = pendingPhase(protocol);
          if (!phase) return;
          protocol.completeAfterPaint(phase, transactionCount);
        }
      }} />
    </TabNavProvider>
  );
}
