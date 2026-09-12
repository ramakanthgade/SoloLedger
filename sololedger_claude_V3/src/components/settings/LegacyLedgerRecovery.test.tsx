import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { db, listBrowserLedgers, selectBrowserLedgerForReload } from '@/lib/storage/db';
import { LegacyLedgerRecovery } from './LegacyLedgerRecovery';

const names = ['sololedger_legacy-account-A', 'sololedger_legacy-account-B'];
async function seedLedgers() {
  await db.open();
  await db.transactions.put({ id: 'local-retained', timestamp: 1, type: 'buy', asset: 'BTC', amount: 1, fiatCurrency: 'INR', fiatValue: 100, source: 'manual', flags: [], isInternalTransfer: false });
  for (const [index, name] of names.entries()) {
    const legacy = new Dexie(name);
    legacy.version(1).stores({ transactions: 'id' });
    await legacy.table('transactions').put({ id: `legacy-${index}`, fiatValue: index + 200 });
    legacy.close();
  }
}
afterEach(async () => {
  for (const name of names) await Dexie.delete(name);
  localStorage.removeItem('sololedger_active_ledger');
  await db.transactions.clear();
});

it('discovers populated local and account A/B ledgers and selects without merging or overwriting', async () => {
  await seedLedgers();
  const ledgers = await listBrowserLedgers();
  expect(ledgers).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: db.name, transactionCount: 1, active: true }),
    ...names.map(name => expect.objectContaining({ name, transactionCount: 1, active: false }))
  ]));
  for (const name of names) {
    await selectBrowserLedgerForReload(name);
    expect(localStorage.getItem('sololedger_active_ledger')).toBe(name);
    expect((await db.transactions.get('local-retained'))?.fiatValue).toBe(100);
    const legacy = new Dexie(name); await legacy.open();
    expect(await legacy.table('transactions').count()).toBe(1);
    legacy.close();
  }
  await selectBrowserLedgerForReload(db.name);
  expect(localStorage.getItem('sololedger_active_ledger')).toBe(db.name);
  await expect(selectBrowserLedgerForReload('nonexistent-ledger')).rejects.toThrow('unavailable');
});

it('makes older ledgers discoverable and requires explicit confirmation before reload, explaining export', async () => {
  await seedLedgers();
  const reload = vi.fn();
  render(<LegacyLedgerRecovery reload={reload} />);
  fireEvent.click(screen.getByRole('button', { name: 'Discover browser ledgers' }));
  fireEvent.click(await screen.findByRole('button', { name: `Select ledger ${names[1]}` }));
  expect(screen.getByText(/Then use Export full backup/)).toHaveTextContent('sensitive, unencrypted copy');
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: `Select ledger ${names[0]}` }));
  fireEvent.click(screen.getByRole('button', { name: 'Open selected ledger' }));
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(localStorage.getItem('sololedger_active_ledger')).toBe(names[0]);
});
