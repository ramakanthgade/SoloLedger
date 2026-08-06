const WALLET_APP_LABELS: Readonly<Record<string, string>> = {
  metamask: 'MetaMask',
  trustwallet: 'Trust Wallet',
  ledger: 'Ledger',
  phantom: 'Phantom',
  trezor: 'Trezor'
};

export function shortWalletAddress(address: string): string {
  const exact = address.trim();
  return exact.length > 14 ? `${exact.slice(0, 6)}…${exact.slice(-4)}` : exact;
}

function walletAppLabel(walletAppId?: string | null): string | undefined {
  const exact = walletAppId?.trim();
  if (!exact) return undefined;
  return WALLET_APP_LABELS[exact.toLowerCase()] ?? exact.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Canonical account-facing label shared by every wallet surface. */
export function resolveWalletDisplayLabel(input: {
  label?: string | null;
  walletAppId?: string | null;
  address: string;
}): string {
  const explicit = input.label?.trim();
  if (explicit) return explicit;
  const address = shortWalletAddress(input.address);
  const app = walletAppLabel(input.walletAppId);
  if (app && address) return `${app} · ${address}`;
  return address || app || 'Wallet account';
}
