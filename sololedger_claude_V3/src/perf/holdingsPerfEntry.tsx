import { createRoot } from 'react-dom/client';
import { clearAllData, db, getSettings } from '@/lib/storage/db';
import { buildPostingPerformanceFixtures } from '@/lib/ledger/postingBalances.performanceFixture';
import type { Transaction } from '@/types/transaction';
import { HoldingsPerfDashboard } from './HoldingsPerfDashboard';
import { installHoldingsPerfProtocol } from './holdingsPerfProbe';
import '@/index.css';

const rootElement = (() => {
  const element = document.getElementById('root');
  if (!element) throw new Error('Missing holdings performance root');
  return element;
})();

function showStatus(testId: string, transactionCount: number, message: string) {
  rootElement.innerHTML = '';
  const status = document.createElement('output');
  status.dataset.testid = testId;
  status.dataset.transactionCount = String(transactionCount);
  status.textContent = message;
  rootElement.append(status);
}

async function seedDatabase() {
  await db.open();
  const existingCount = await db.transactions.count();
  const fixtureEndpointsPresent = Boolean(
    await db.transactions.get('p-0') && await db.transactions.get('p-29999')
  );
  if (fixtureEndpointsPresent && (existingCount === 30_000 || existingCount === 30_001)) {
    const liveKeys = (await db.transactions.toCollection().primaryKeys())
      .filter((key) => String(key).startsWith('holdings-live-'));
    if (liveKeys.length !== existingCount - 30_000) {
      throw new Error(`Unexpected holdings fixture state: ${existingCount} rows and ${liveKeys.length} live rows`);
    }
    if (liveKeys.length > 0) await db.transactions.bulkDelete(liveKeys);
  } else {
    await clearAllData();
    await db.transactions.bulkPut(buildPostingPerformanceFixtures());
  }
  // The fixture's manual-perf rows model one CSV source. Keep its source
  // metadata coherent with the ledger so the production Dashboard's initial
  // CSV identity barrier is exercised rather than bypassed by the perf harness.
  await db.csvImports.put({
    id: 'manual-perf', fileName: 'holdings-perf.csv', importedAt: 1,
    txCount: 15_000, parserId: 'test'
  });
  const [transactionCount, settings] = await Promise.all([db.transactions.count(), getSettings()]);
  if (transactionCount !== 30_000) {
    throw new Error(`Expected 30000 seeded transactions, received ${transactionCount}`);
  }
  if (settings.priceApiEnabled || settings.rpcLookupEnabled) {
    throw new Error('Holdings performance gate requires offline lookup settings');
  }
  showStatus('holdings-perf-seed-ready', transactionCount, `${transactionCount} transactions ready`);
}

async function appendLiveUpdate(sampleId: number): Promise<void> {
  const lastTransaction = await db.transactions.orderBy('timestamp').last();
  if (!lastTransaction) throw new Error('Cannot append a live update to an empty database');
  const transaction: Transaction = {
    id: `holdings-live-${sampleId}`,
    timestamp: lastTransaction.timestamp + 1_000,
    // Use an acquisition with explicit basis so the coherent Dashboard chart
    // endpoint must publish both the quantity and remaining-cost update.
    type: 'buy',
    asset: 'BTC',
    amount: 1,
    fiatCurrency: 'INR',
    fiatValue: 5_000_000,
    source: 'manual',
    flags: [],
    isInternalTransfer: false
  };
  await db.transaction('rw', db.transactions, () => db.transactions.put(transaction));
  // The coherent Dashboard reacts to the committed revision. Measure from the
  // commit boundary rather than including IndexedDB write latency in the
  // projection-and-paint contract.
  window.__SOLOLEDGER_HOLDINGS_PERF__!.begin('live-update');
}

async function runDashboard() {
  await db.open();
  const transactionCount = await db.transactions.count();
  if (transactionCount !== 30_000) {
    throw new Error(`Run mode requires exactly 30000 transactions, received ${transactionCount}`);
  }
  const settings = await getSettings();
  if (settings.priceApiEnabled || settings.rpcLookupEnabled) {
    throw new Error('Run mode requires offline lookup settings');
  }
  const protocol = installHoldingsPerfProtocol();
  window.appendLiveUpdate = appendLiveUpdate;
  protocol.begin('initial');
  createRoot(rootElement).render(<HoldingsPerfDashboard protocol={protocol} />);
}

declare global {
  interface Window {
    appendLiveUpdate?: (sampleId: number) => Promise<void>;
  }
}

const mode = new URLSearchParams(location.search).get('mode');
const operation = mode === 'seed'
  ? navigator.locks.request('sololedger-holdings-perf-seed', seedDatabase)
  : runDashboard();
void operation.catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  showStatus('holdings-perf-error', -1, message);
  throw error;
});
