/**
 * Chain normalization + block-explorer link helpers.
 *
 * Shared by the parser (to normalize a "Network" column into a canonical chain
 * id and to decide whether a source ref is a REAL tx hash) and the Review UI
 * (to render an explorer link only when we actually have a real hash + a chain
 * we know an explorer for). Pure + dependency-free so both can import it.
 */

/**
 * Normalize a raw exchange "Network"/"Chain" cell into a canonical chain id.
 * Conservative: an unrecognized network returns `undefined` (never guess).
 */
export function normalizeChain(network?: string): string | undefined {
  if (!network) return undefined;
  const n = network.trim().toUpperCase();
  if (!n) return undefined;
  switch (n) {
    case 'ETH':
    case 'ETHEREUM':
    case 'ERC20':
    case 'ERC-20':
      return 'ethereum';
    case 'SOL':
    case 'SOLANA':
    case 'SPL':
      return 'solana';
    case 'BSC':
    case 'BNB':
    case 'BEP20':
    case 'BEP-20':
      return 'bsc';
    case 'MATIC':
    case 'POLYGON':
      return 'polygon';
    case 'ARB':
    case 'ARBITRUM':
      return 'arbitrum';
    case 'BASE':
      return 'base';
    case 'OP':
    case 'OPTIMISM':
      return 'optimism';
    case 'AVAX':
    case 'AVALANCHE':
      return 'avalanche';
    case 'BTC':
    case 'BITCOIN':
      return 'bitcoin';
    case 'ADA':
    case 'CARDANO':
      return 'cardano';
    default:
      return undefined;
  }
}

/**
 * Synthetic sourceRef prefixes that are NOT real on-chain hashes. `chash:` is
 * produced by `contentHashRef` (manual/AI imports); `row:` is a legacy
 * positional ref. `<source>:` exchange refs (e.g. `binance:...`) also carry a
 * colon-separated prefix and are not linkable hashes.
 */
const SYNTHETIC_REF_PREFIXES = ['chash:', 'row:'];

/**
 * Whether `ref` is plausibly a REAL on-chain transaction hash worth linking to
 * a block explorer. Conservative — when unsure, returns false so the UI shows
 * plain text instead of a broken link.
 */
export function isRealTxHash(ref?: string): boolean {
  if (!ref) return false;
  const s = ref.trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  for (const p of SYNTHETIC_REF_PREFIXES) {
    if (lower.startsWith(p)) return false;
  }
  // EVM tx hash: 0x followed by hex. Real ones are 64 hex chars; accept >=6 to
  // stay lenient for truncated fixtures while still rejecting junk.
  if (/^0x[0-9a-f]{6,}$/i.test(s)) return true;
  // Plausible base58 hash (e.g. Solana signature): base58 alphabet, long.
  if (/^[1-9A-HJ-NP-Za-km-z]{40,}$/.test(s)) return true;
  return false;
}

/** chain id → explorer `/tx/` base URL. */
const EXPLORER_TX_BASE: Record<string, string> = {
  ethereum: 'https://etherscan.io/tx/',
  bsc: 'https://bscscan.com/tx/',
  polygon: 'https://polygonscan.com/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
  optimism: 'https://optimistic.etherscan.io/tx/',
  base: 'https://basescan.org/tx/',
  avalanche: 'https://snowtrace.io/tx/',
  solana: 'https://solscan.io/tx/',
  bitcoin: 'https://mempool.space/tx/'
};

/**
 * Build an explorer URL for `hash` on `chain`, or `null` when the chain is
 * unknown/missing or has no explorer entry (e.g. cardano).
 */
export function explorerTxUrl(chain: string | undefined, hash: string): string | null {
  if (!chain || !hash) return null;
  const base = EXPLORER_TX_BASE[chain];
  return base ? `${base}${hash}` : null;
}
