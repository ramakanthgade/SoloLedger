import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { db, switchUserDatabase, getSettings, DEFAULT_SETTINGS, saveSettings } from '@/lib/storage/db';
import { setMode, initMode, APP_MODE_KEY } from './mode';
import { setAuthToken } from './api';

beforeEach(async () => { localStorage.clear(); setMode('local'); await db.transactions.clear(); await db.settings.clear(); });
it('migrates legacy mode without deleting ledger or permitting legacy keys', async () => {
  await db.transactions.put({ id: 'retained', type: 'buy', asset: 'HNT', amount: 100, timestamp: 1721174400000, fiatCurrency: 'INR', fiatValue: 35000, source: 'wazirx', flags: [], isInternalTransfer: false });
  await saveSettings({ ...DEFAULT_SETTINGS, alchemyApiKey: 'legacy-key', aiApiKey: 'legacy-ai', priceApiEnabled: true, rpcLookupEnabled: true });
  localStorage.setItem(APP_MODE_KEY, 'byok');
  expect(initMode()).toBe('local');
  const settings = await getSettings();
  expect(settings.alchemyApiKey).toBeUndefined();
  expect(settings.aiApiKey).toBeUndefined();
  expect(settings.priceApiEnabled).toBe(false);
  expect(settings.rpcLookupEnabled).toBe(false);
  expect((await db.transactions.get('retained'))?.fiatValue).toBe(35000);
});
it('local → account → signout retains the same database and transaction without network', async () => {
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  await db.transactions.put({ id: 'local-row', type: 'buy', asset: 'BTC', amount: 1, timestamp: 1, fiatCurrency: 'INR', fiatValue: 100, source: 'manual', flags: [], isInternalTransfer: false });
  const name = db.name;
  setMode('hosted'); setAuthToken('test-auth');
  await switchUserDatabase('account-one');
  expect(db.name).toBe(name);
  expect(await db.transactions.get('local-row')).toBeDefined();
  setAuthToken(null); await switchUserDatabase(null); setMode('local');
  expect(db.name).toBe(name);
  expect(await db.transactions.get('local-row')).toBeDefined();
  expect(fetchSpy).not.toHaveBeenCalled();
});
