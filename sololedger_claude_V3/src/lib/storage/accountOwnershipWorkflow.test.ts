import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { walletAccountCanonicalKey } from '@/lib/accounts/accountIdentity';
import {
  claimAccountOwnershipPrompt,
  db,
  ensureAccountIdentity,
  updateAccountOwnership
} from './db';

const ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('durable account ownership prompt workflow', () => {
  beforeEach(async () => {
    await db.accountIdentities.clear();
  });

  it('uses one canonical EVM account across chains and grants one concurrent claim', async () => {
    const ethereum = await ensureAccountIdentity({
      kind: 'wallet', canonicalKey: walletAccountCanonicalKey('ethereum', ADDRESS), label: 'Main wallet'
    });
    const polygon = await ensureAccountIdentity({
      kind: 'wallet', canonicalKey: walletAccountCanonicalKey('polygon', ADDRESS), label: 'Other label'
    });
    expect(polygon.id).toBe(ethereum.id);

    const claims = await Promise.all([
      claimAccountOwnershipPrompt(ethereum.id, 100),
      claimAccountOwnershipPrompt(ethereum.id, 101)
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect((await db.accountIdentities.get(ethereum.id))?.ownershipDismissedAt).toBe(100);
  });

  it('never reclaims after navigation-style dismissal or a durable answer', async () => {
    const account = await ensureAccountIdentity({
      kind: 'wallet', canonicalKey: walletAccountCanonicalKey('ethereum', ADDRESS)
    });
    const first = await claimAccountOwnershipPrompt(account.id, 100);
    expect(first.claimed).toBe(true);
    expect((await claimAccountOwnershipPrompt(account.id, 200)).claimed).toBe(false);

    const owned = await updateAccountOwnership(
      account.id, { status: 'owned', origin: 'user' }, first.account.lifecycleRevision, 300
    );
    expect(owned.ownershipStatus).toBe('owned');
    expect((await claimAccountOwnershipPrompt(account.id, 400)).claimed).toBe(false);
  });

  it('keeps distinct addresses separate and rejects stale edits', async () => {
    const first = await ensureAccountIdentity({
      kind: 'wallet', canonicalKey: walletAccountCanonicalKey('ethereum', ADDRESS)
    });
    const second = await ensureAccountIdentity({
      kind: 'wallet', canonicalKey: walletAccountCanonicalKey('ethereum', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    });
    expect(first.id).not.toBe(second.id);
    const claimed = await claimAccountOwnershipPrompt(first.id);
    await updateAccountOwnership(first.id, { status: 'owned', origin: 'user' }, claimed.account.lifecycleRevision);
    await expect(updateAccountOwnership(
      first.id, { status: 'not_owned', origin: 'user' }, claimed.account.lifecycleRevision
    )).rejects.toThrow(/changed while the update was in progress/i);
  });
});
