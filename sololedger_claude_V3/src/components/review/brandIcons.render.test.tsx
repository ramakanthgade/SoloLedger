import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AssetIcon, SourceIcon } from './brandIcons';
import { principalAssetIdentityForLeg, reviewAssetLogoUrl } from './reviewAssetIcons';
import { txFlow } from './rowAnatomy';

describe('Review source icons', () => {
  it('renders MetaMask from the shared local real-brand registry', () => {
    const { container } = render(<SourceIcon iconId="metamask" label="Main MetaMask" size={30} />);
    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', expect.stringContaining('/assets/brand-icons/metamask.svg'));
    expect(container).not.toHaveTextContent('ME');
  });

  it('uses only exact canonical trusted local asset identity and rejects a malicious USDC ticker', () => {
    const canonicalUsdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    expect(reviewAssetLogoUrl({ symbol: 'USDC', chain: 'ethereum', contractAddress: canonicalUsdc, safetyState: 'trusted' }))
      .toContain('/assets/brand-icons/usdc.png');
    expect(reviewAssetLogoUrl({ symbol: 'USDC', chain: 'ethereum', contractAddress: '0x1111111111111111111111111111111111111111', safetyState: 'unverified' }))
      .toBeNull();
    const { container } = render(<AssetIcon symbol="USDC" chain="ethereum" contractAddress="0x1111111111111111111111111111111111111111" safetyState="unverified" />);
    expect(screen.getByRole('img', { name: 'USDC icon unavailable' })).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('logos canonical USDC only on the principal leg while an unidentified same-symbol counter stays neutral', () => {
    const canonicalUsdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const transaction = {
      id: 'same-symbol', timestamp: 1, type: 'trade' as const, asset: 'USDC', amount: 10,
      counterAsset: 'USDC', counterAmount: 10, fiatCurrency: 'USD', source: 'rpc:alchemy',
      chain: 'ethereum', contractAddress: canonicalUsdc, safetyState: 'trusted' as const,
      flags: [], isInternalTransfer: false
    };
    const flow = txFlow(transaction, { assetLabel: 'USDC', counterLabel: 'USDC' });
    const { container } = render(<>
      <AssetIcon symbol={flow.sent!.symbol} {...principalAssetIdentityForLeg(flow.sent!, transaction)} />
      <AssetIcon symbol={flow.received!.symbol} {...principalAssetIdentityForLeg(flow.received!, transaction)} />
    </>);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('img')).toHaveAttribute('src', expect.stringContaining('/assets/brand-icons/usdc.png'));
    expect(screen.getByRole('img', { name: 'USDC icon unavailable' })).toBeInTheDocument();
  });

  it('uses an accessible neutral fallback for unknown and failed assets', () => {
    const { container, rerender } = render(<SourceIcon iconId="not-a-real-brand" label="Unresolved source" size={30} />);
    expect(screen.getByRole('img', { name: 'Unresolved source icon unavailable' })).toBeInTheDocument();
    expect(container).not.toHaveTextContent('NO');

    rerender(<SourceIcon iconId="metamask" label="Main MetaMask" size={30} />);
    fireEvent.error(container.querySelector('img')!);
    expect(screen.getByRole('img', { name: 'Main MetaMask icon unavailable' })).toBeInTheDocument();
    expect(container).not.toHaveTextContent('ME');
  });
});
