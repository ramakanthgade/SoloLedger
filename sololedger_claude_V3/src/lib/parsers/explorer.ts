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
 * Whether `ref` is a REAL source ref (i.e. NOT a synthetic content-hash /
 * positional ref). This is only the cheap "is this synthetic" rejector — it
 * does NOT assert full hash shape. Use `isValidTxHashForChain` / `explorerTxUrl`
 * to decide whether a value is actually linkable to a block explorer.
 */
export function isRealTxHash(ref?: string): boolean {
  if (!ref) return false;
  const s = ref.trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  for (const p of SYNTHETIC_REF_PREFIXES) {
    if (lower.startsWith(p)) return false;
  }
  return true;
}

/** EVM 32-byte tx hash: 0x + 64 hex. */
const EVM_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
/** Bitcoin txid: 64 hex, no 0x prefix. */
const BTC_HASH_RE = /^[0-9a-fA-F]{64}$/;
/** Solana signature: base58, typically 87-88 chars. Range kept generous. */
const SOL_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{43,90}$/;

const EVM_CHAINS = new Set([
  'ethereum',
  'bsc',
  'polygon',
  'arbitrum',
  'optimism',
  'base',
  'avalanche'
]);

/**
 * Chain-aware tx-hash shape validity. Returns false for unknown chains and for
 * values that don't match the chain's expected hash shape (e.g. a truncated
 * `0xdeadbeef` on ethereum), so we never build a broken explorer link.
 */
export function isValidTxHashForChain(chain: string | undefined, hash?: string): boolean {
  if (!chain || !hash) return false;
  const s = hash.trim();
  if (!s) return false;
  if (EVM_CHAINS.has(chain)) return EVM_HASH_RE.test(s);
  if (chain === 'bitcoin') return BTC_HASH_RE.test(s);
  if (chain === 'solana') return SOL_SIG_RE.test(s);
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
 * unknown/missing, has no explorer entry (e.g. cardano), or the hash does not
 * match the chain's expected shape. Enforcing the shape here means a caller can
 * treat a non-null result as "safe to link".
 */
export function explorerTxUrl(chain: string | undefined, hash: string): string | null {
  if (!chain || !hash) return null;
  if (!isValidTxHashForChain(chain, hash)) return null;
  const base = EXPLORER_TX_BASE[chain];
  return base ? `${base}${hash}` : null;
}
