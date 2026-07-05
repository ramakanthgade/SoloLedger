/** Well-known Solana SPL mint addresses → ticker symbols. */
export const SOLANA_KNOWN_MINTS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  So11111111111111111111111111111111111111112: 'SOL',
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 'mSOL',
  J1toso1uCk3RLmjorhTtrVwY9HJIVXAxVrXzPzdr1Gbr: 'jitoSOL',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'ETH',
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': 'stSOL'
};

export function resolveSolanaMintSymbol(mint: string): string | undefined {
  return SOLANA_KNOWN_MINTS[mint];
}

/** Prefer a human ticker over a truncated mint placeholder like `AbCd…wxyz`. */
export function resolveAssetLabel(asset: string, contractAddress?: string, chain?: string): string {
  if (chain === 'solana' && contractAddress) {
    const known = resolveSolanaMintSymbol(contractAddress);
    if (known) return known;
  }
  if (asset.includes('…') && contractAddress && chain === 'solana') {
    const known = resolveSolanaMintSymbol(contractAddress);
    if (known) return known;
  }
  return asset;
}
