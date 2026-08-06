/** Shared provider/UI wallet-address shape validation. */

const BITCOIN_LEGACY_ADDRESS = /^(?:1|3)[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const BITCOIN_BECH32_ADDRESS = /^bc1[ac-hj-np-z02-9]{6,87}$/i;
const SOLANA_BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const STARKNET_ADDRESS = /^0x[0-9a-fA-F]{1,64}$/;
const STARKNET_ADDRESS_BOUND = 1n << 251n;

export function isBitcoinAddress(address: string): boolean {
  const value = address.trim();
  if (BITCOIN_LEGACY_ADDRESS.test(value)) return true;
  if (!BITCOIN_BECH32_ADDRESS.test(value)) return false;
  return value === value.toLowerCase() || value === value.toUpperCase();
}

export function isSolanaAddress(address: string): boolean {
  return SOLANA_BASE58_ADDRESS.test(address.trim());
}

export function isEvmAddress(address: string): boolean {
  return EVM_ADDRESS.test(address.trim());
}

export function isStarknetAddress(address: string): boolean {
  const value = address.trim();
  if (!STARKNET_ADDRESS.test(value)) return false;
  const numeric = BigInt(value);
  return numeric > 0n && numeric < STARKNET_ADDRESS_BOUND;
}

export function isValidWalletAddress(namespace: string, address: string): boolean {
  if (namespace === 'bitcoin') return isBitcoinAddress(address);
  if (namespace === 'solana') return isSolanaAddress(address);
  if (namespace === 'evm') return isEvmAddress(address);
  if (namespace === 'starknet') return isStarknetAddress(address);
  return false;
}
