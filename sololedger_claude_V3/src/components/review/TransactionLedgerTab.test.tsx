import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DerivedPosting } from '@/lib/ledger/derivedPostings';
import { TransactionLedgerTab } from './TransactionLedgerTab';

const posting: DerivedPosting = {
  id: 'tx:10:0:wallet:ethereum:usdc',
  taxEventId: 'tx',
  transactionId: 'tx',
  accountScopeId: 'wallet:evm:1:0x1111',
  accountClass: 'wallet',
  assetKey: 'ethereum:usdc',
  asset: 'USDC',
  signedQuantity: 25,
  role: 'principal',
  postingPhase: 10,
  ordinal: 0,
  effectiveAt: 1_785_945_600_000,
  evidence: [{
    kind: 'transaction', transactionId: 'tx', role: 'direct', source: 'rpc:ethereum',
    sourceRef: 'moralis:event:ethereum:erc20:staking-reward:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:17'
  }],
  taxableEffect: 'source_transaction_only'
};

describe('TransactionLedgerTab', () => {
  it('provides a complete semantic mobile posting card and retains the desktop table headers', () => {
    render(<TransactionLedgerTab postings={[posting]} runningBalances={new Map([[posting.id, 125]])} />);

    const mobileRegion = screen.getByRole('region', { name: 'Transaction custody postings' });
    expect(mobileRegion).toContainElement(screen.getByRole('article', { name: 'Primary asset movement' }));
    expect(screen.getAllByTestId('ledger-mobile-label').map((label) => label.textContent)).toEqual([
      'Posting', 'Ledger', 'Evidence', 'Signed change', 'Running balance'
    ]);
    expect(mobileRegion).toHaveTextContent('moralis:event:ethereum:erc20:staking-reward');
    expect(mobileRegion).toHaveTextContent('+25.0000 USDC');
    expect(mobileRegion).toHaveTextContent('125.0000 USDC');

    const table = screen.getByRole('table');
    expect(table).toHaveAccessibleName('');
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Posting', 'Ledger', 'Evidence', 'Signed change', 'Running balance'
    ]);
  });
});
