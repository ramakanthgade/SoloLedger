import { describe, expect, it } from 'vitest';
import type { AccountIdentityRow } from '@/lib/accounts/accountIdentity';
import type { SourcePresentation } from '@/lib/sources/sourcePresentation';
import type { Transaction } from '@/types/transaction';
import {
  buildReviewWalletFilterOptions,
  persistReviewWalletFilter,
  readPersistedReviewWalletFilter,
  transactionMatchesWalletFilter
} from './reviewWalletFilters';

const account = { id: 'account:durable', label: 'Treasury' } as AccountIdentityRow;
const transaction = (id: string): Transaction => ({ id } as Transaction);
const presentation = (sourceKey: string, chain: string): SourcePresentation => ({
  accountKey: account.canonicalKey,
  sourceKey,
  primaryLabel: account.label!,
  subtitle: chain,
  filterLabel: `${account.label} · ${chain}`,
  iconId: 'metamask',
  chain,
  address: '0xabc',
  status: 'resolved',
  account,
  sourceKind: 'wallet',
  linkedDeletedSourceEvidence: null
});

describe('durable Review wallet filters', () => {
  it('deduplicates chain sources by account identity while matching every linked chain', () => {
    const ethereum = transaction('ethereum');
    const polygon = transaction('polygon');
    const presentations = new Map([
      [ethereum.id, presentation('wallet-source:ethereum', 'ethereum')],
      [polygon.id, presentation('wallet-source:polygon', 'polygon')]
    ]);

    expect(buildReviewWalletFilterOptions([ethereum, polygon], presentations)).toEqual([{
      accountIdentityId: account.id,
      label: 'Treasury',
      address: '0xabc'
    }]);
    expect(transactionMatchesWalletFilter(ethereum, account.id, presentations)).toBe(true);
    expect(transactionMatchesWalletFilter(polygon, account.id, presentations)).toBe(true);
  });

  it('persists the durable id, which is unaffected by a label rename', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); }
    };
    persistReviewWalletFilter(account.id, storage);
    account.label = 'Renamed treasury';
    expect(readPersistedReviewWalletFilter(storage)).toBe(account.id);
    persistReviewWalletFilter('all', storage);
    expect(readPersistedReviewWalletFilter(storage)).toBe('all');
  });
});
