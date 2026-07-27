import { BRAND_ICON_BASE } from '@/lib/brandAssets';

/**
 * Data-driven wallet-app catalog — the Koinly-style picker behind the
 * drawer's "Wallet app" flow (live-feedback round, item 3).
 *
 * Every wallet uses the exact same watch-only address/xPub connect flow, so
 * each entry is metadata only: display name, a one-line ecosystem hint, the
 * logo file under `public/assets/brand-icons/` (provenance in SOURCES.md),
 * and chain hints used to pre-select the connect form's chain.
 *
 * Long-tail wallets slot in as data-only batches later — no code changes
 * needed. Entries without a `logo` render the clean aurora letter chip
 * (documented in SOURCES.md — no legitimate asset could be sourced).
 */
import type { ChainId } from '@/lib/rpc/providers';

export type WalletGroup =
  | 'Popular wallets'
  | 'EVM & multi-chain'
  | 'Solana'
  | 'Cardano'
  | 'Bitcoin'
  | 'Hardware'
  | 'Cosmos'
  | 'Other chains';

export interface WalletCatalogEntry {
  /** Kebab slug — also the brandIcons registry key when `logo` is set. */
  id: string;
  name: string;
  /** One-line chain/ecosystem hint shown under the name. */
  subtitle: string;
  /** Picker section. */
  group: WalletGroup;
  /**
   * Chains this wallet is typically used for; the first one pre-selects the
   * connect form's chain. Empty for ecosystems the lookup layer does not
   * index (Cardano, Cosmos, TRON, XRP Ledger…) — the user picks manually.
   */
  chains: ChainId[];
  /**
   * Bundled logo under `/assets/brand-icons/` — never hotlinked. Omit only
   * when no legitimate asset exists (see SOURCES.md) → letter-chip fallback.
   */
  logo?: string;
  /** Official brand color painted BEHIND a no-fill glyph (Simple Icons). */
  tile?: string;
  /** No-alpha or dark-mark raster — render on a white chip in both themes. */
  lightChip?: boolean;
  /**
   * Extra lowercase names users give this wallet ("MEW", "Coinbase Wallet"),
   * used by the Wallet-app lane classifier alongside `name`.
   */
  aliases?: string[];
  /**
   * Generic affordance, NOT a brand (the "Any other wallet" tile): the picker
   * renders a neutral lucide glyph chip — never a logo, never the aurora
   * letter-chip fallback (the real-logos rule doesn't apply to non-brands).
   */
  genericGlyph?: 'wallet';
}

const ICONS = BRAND_ICON_BASE;

/** Catalog id of the generic "Any other wallet" tile (round-4 item 2). */
export const ANY_WALLET_ID = 'any-wallet';
/** Name prefill when connecting via the generic tile (editable, still required). */
export const ANY_WALLET_DEFAULT_NAME = 'My wallet';

/**
 * Every chain the lookup layer can watch — the generic tile is chain-agnostic,
 * so its hints span all supported ChainIds (the first pre-selects the form's
 * chain; the pasted address's own format auto-detect takes over from there).
 */
const ANY_WALLET_CHAINS: ChainId[] = [
  'bitcoin',
  'ethereum',
  'solana',
  'polygon',
  'arbitrum',
  'base',
  'bsc',
  'optimism',
  'avalanche',
  'celo',
  'zksync',
  'linea',
  'scroll',
  'blast',
  'mantle',
  'starknet',
  'aurora',
  'cronos',
  'gnosis',
  'moonbeam',
  'moonriver',
  'metis',
  'opbnb',
  'abstract',
  'apechain',
  'anime',
  'berachain',
  'hyperevm',
  'ink',
  'lens',
  'monad',
  'mythos',
  'robinhood',
  'rootstock',
  'ronin',
  'shape',
  'settlus',
  'soneium',
  'story',
  'unichain',
  'worldchain',
  'zora',
  'zetachain',
  'fraxtal',
  'sei',
  'sonic',
  'plasma',
  'stable',
  'megaeth',
  'katana'
];

/** Section order in the picker (groups not listed here would render last). */
export const WALLET_GROUP_ORDER: WalletGroup[] = [
  'Popular wallets',
  'EVM & multi-chain',
  'Solana',
  'Cardano',
  'Bitcoin',
  'Hardware',
  'Cosmos',
  'Other chains'
];

/** The 60+ wallet catalog, in display order within each group. */
export const WALLET_CATALOG: WalletCatalogEntry[] = [
  // ── Popular wallets ──
  { id: 'metamask', name: 'MetaMask', aliases: ['meta mask'], subtitle: 'Ethereum & EVM chains', group: 'Popular wallets', chains: ['ethereum'], logo: `${ICONS}/metamask.svg` },
  { id: 'trustwallet', name: 'Trust Wallet', aliases: ['trustwallet'], subtitle: 'Multi-chain mobile wallet', group: 'Popular wallets', chains: ['ethereum', 'bsc'], logo: `${ICONS}/trustwallet.svg` },
  { id: 'phantom', name: 'Phantom', subtitle: 'Solana & EVM', group: 'Popular wallets', chains: ['solana', 'ethereum'], logo: `${ICONS}/phantom.svg` },
  { id: 'rabby', name: 'Rabby', subtitle: 'Ethereum & EVM chains', group: 'Popular wallets', chains: ['ethereum'], logo: `${ICONS}/rabby.svg` },
  { id: 'baseapp', name: 'Base App (Coinbase Wallet)', aliases: ['base app', 'coinbase wallet'], subtitle: 'Base, Ethereum & EVM chains', group: 'Popular wallets', chains: ['base', 'ethereum'], logo: `${ICONS}/baseapp.svg` },
  { id: 'ledger', name: 'Ledger', subtitle: 'Hardware wallet · BTC & ETH · xPub friendly', group: 'Popular wallets', chains: ['bitcoin', 'ethereum'], logo: `${ICONS}/ledger.svg` },
  { id: 'keplr', name: 'Keplr', subtitle: 'Cosmos ecosystem wallet', group: 'Popular wallets', chains: [], logo: `${ICONS}/keplr.png` },
  { id: 'exodus', name: 'Exodus', subtitle: 'Multi-chain desktop & mobile', group: 'Popular wallets', chains: ['bitcoin', 'ethereum', 'solana'], logo: `${ICONS}/exodus.svg` },
  // Generic catch-all — pinned LAST in Popular wallets (round-4 item 2). Not a
  // brand: the picker renders the neutral lucide Wallet glyph chip, and the
  // connect form prefills the name "My wallet" (ANY_WALLET_DEFAULT_NAME).
  {
    id: ANY_WALLET_ID,
    name: 'Any other wallet',
    aliases: ['any wallet', 'another wallet', 'other wallet', 'generic wallet'],
    subtitle: 'Connect any wallet by address or xPub',
    group: 'Popular wallets',
    chains: ANY_WALLET_CHAINS,
    genericGlyph: 'wallet'
  },

  // ── EVM & multi-chain ──
  { id: 'okxwallet', name: 'OKX Web3 Wallet', aliases: ['okx wallet'], subtitle: 'Multi-chain Web3 wallet by OKX', group: 'EVM & multi-chain', chains: ['ethereum'], logo: `${ICONS}/okx.svg`, tile: '#FFFFFF' },
  { id: 'bitget', name: 'Bitget Web3 Wallet', subtitle: 'Multi-chain Web3 wallet by Bitget', group: 'EVM & multi-chain', chains: ['ethereum', 'bsc'], logo: `${ICONS}/bitget.svg` },
  { id: 'brave', name: 'Brave Wallet', aliases: ['brave'], subtitle: 'Built into the Brave browser', group: 'EVM & multi-chain', chains: ['ethereum'], logo: `${ICONS}/brave.svg` },
  { id: 'oneinch', name: '1inch Wallet', subtitle: 'DeFi wallet by 1inch', group: 'EVM & multi-chain', chains: ['ethereum'], logo: `${ICONS}/oneinch.svg` },
  { id: 'uniswap', name: 'Uniswap Wallet', aliases: ['uniswap'], subtitle: 'Mobile wallet by Uniswap', group: 'EVM & multi-chain', chains: ['ethereum'], logo: `${ICONS}/uniswap.svg` },
  { id: 'atomic', name: 'Atomic Wallet', subtitle: 'Multi-chain desktop & mobile', group: 'EVM & multi-chain', chains: ['ethereum'], logo: `${ICONS}/atomic.svg` },
  { id: 'guarda', name: 'Guarda', subtitle: 'Multi-chain wallet', group: 'EVM & multi-chain', chains: ['ethereum'], logo: `${ICONS}/guarda.png` },
  { id: 'enkrypt', name: 'Enkrypt', subtitle: 'EVM & Polkadot wallet by MEW', group: 'EVM & multi-chain', chains: ['ethereum'], logo: `${ICONS}/enkrypt.svg` },
  { id: 'mew', name: 'MEW (MyEtherWallet)', aliases: ['mew', 'myetherwallet'], subtitle: 'Ethereum & EVM chains', group: 'EVM & multi-chain', chains: ['ethereum'], logo: `${ICONS}/mew.svg` },
  { id: 'talisman', name: 'Talisman', subtitle: 'EVM & Polkadot ecosystem', group: 'EVM & multi-chain', chains: ['ethereum'], logo: `${ICONS}/talisman.svg` },
  { id: 'tokenpocket', name: 'TokenPocket', aliases: ['token pocket'], subtitle: 'Multi-chain mobile wallet', group: 'EVM & multi-chain', chains: ['ethereum'], logo: `${ICONS}/tokenpocket.svg` },
  { id: 'safepal', name: 'SafePal', subtitle: 'Hardware + mobile wallet', group: 'EVM & multi-chain', chains: ['ethereum', 'bsc'], logo: `${ICONS}/safepal.svg` },
  { id: 'krakenwallet', name: 'Kraken Wallet', aliases: ['kraken wallet'], subtitle: 'Self-custody wallet by Kraken', group: 'EVM & multi-chain', chains: ['ethereum', 'solana'], logo: `${ICONS}/krakenwallet.svg` },
  { id: 'robinhood', name: 'Robinhood Wallet', aliases: ['robinhood'], subtitle: 'Self-custody wallet by Robinhood', group: 'EVM & multi-chain', chains: ['ethereum', 'polygon'], logo: `${ICONS}/robinhood.svg`, tile: '#00C805' },
  { id: 'zengo', name: 'Zengo', subtitle: 'Keyless (MPC) mobile wallet', group: 'EVM & multi-chain', chains: ['ethereum', 'bitcoin'], logo: `${ICONS}/zengo.png` },
  { id: 'moonpay', name: 'MoonPay', subtitle: 'Wallet inside the MoonPay app', group: 'EVM & multi-chain', chains: ['ethereum', 'solana'], logo: `${ICONS}/moonpay.png` },
  { id: 'opera', name: 'Opera Crypto Browser', aliases: ['opera'], subtitle: 'Wallet built into Opera', group: 'EVM & multi-chain', chains: ['ethereum'], logo: `${ICONS}/opera.svg`, tile: '#FF1B2D' },

  // ── Solana ──
  { id: 'solflare', name: 'Solflare', subtitle: 'Solana wallet', group: 'Solana', chains: ['solana'], logo: `${ICONS}/solflare.svg` },
  { id: 'backpack', name: 'Backpack', subtitle: 'Solana wallet & exchange', group: 'Solana', chains: ['solana'], logo: `${ICONS}/backpack.svg` },

  // ── Cardano (addresses are not indexed by the lookup layer — manual chain pick) ──
  { id: 'eternl', name: 'Eternl', subtitle: 'Cardano wallet', group: 'Cardano', chains: [], logo: `${ICONS}/eternl.png` },
  { id: 'nami', name: 'Nami', subtitle: 'Cardano wallet', group: 'Cardano', chains: [], logo: `${ICONS}/nami.svg` },
  { id: 'yoroi', name: 'Yoroi', subtitle: 'Cardano light wallet', group: 'Cardano', chains: [], logo: `${ICONS}/yoroi.svg` },
  { id: 'lace', name: 'Lace', subtitle: 'Cardano wallet by IOG', group: 'Cardano', chains: [], logo: `${ICONS}/lace.png` },
  // No legitimate Typhon logo could be sourced — letter chip (see SOURCES.md).
  { id: 'typhon', name: 'Typhon', subtitle: 'Cardano wallet', group: 'Cardano', chains: [] },
  { id: 'adalite', name: 'AdaLite', subtitle: 'Cardano web wallet', group: 'Cardano', chains: [], logo: `${ICONS}/adalite.svg` },
  { id: 'daedalus', name: 'Daedalus', subtitle: 'Cardano full-node wallet', group: 'Cardano', chains: [], logo: `${ICONS}/daedalus.png` },

  // ── Bitcoin ──
  { id: 'electrum', name: 'Electrum', subtitle: 'Bitcoin desktop wallet · xPub friendly', group: 'Bitcoin', chains: ['bitcoin'], logo: `${ICONS}/electrum.png` },
  { id: 'bluewallet', name: 'BlueWallet', aliases: ['blue wallet'], subtitle: 'Bitcoin & Lightning', group: 'Bitcoin', chains: ['bitcoin'], logo: `${ICONS}/bluewallet.png` },
  { id: 'sparrow', name: 'Sparrow', subtitle: 'Bitcoin desktop wallet · xPub friendly', group: 'Bitcoin', chains: ['bitcoin'], logo: `${ICONS}/sparrow.png` },
  { id: 'wasabi', name: 'Wasabi Wallet', aliases: ['wasabi'], subtitle: 'Bitcoin privacy wallet', group: 'Bitcoin', chains: ['bitcoin'], logo: `${ICONS}/wasabi.png` },
  { id: 'blockstream', name: 'Blockstream Green', aliases: ['blockstream'], subtitle: 'Bitcoin & Liquid wallet', group: 'Bitcoin', chains: ['bitcoin'], logo: `${ICONS}/blockstream.png` },
  { id: 'cake', name: 'Cake Wallet', aliases: ['cakewallet'], subtitle: 'Bitcoin, Monero & more', group: 'Bitcoin', chains: ['bitcoin'], logo: `${ICONS}/cake.png` },
  { id: 'muun', name: 'Muun', subtitle: 'Bitcoin & Lightning', group: 'Bitcoin', chains: ['bitcoin'], logo: `${ICONS}/muun.png` },
  { id: 'mycelium', name: 'Mycelium', subtitle: 'Bitcoin Android wallet', group: 'Bitcoin', chains: ['bitcoin'], logo: `${ICONS}/mycelium.png` },

  // ── Hardware ──
  { id: 'trezor', name: 'Trezor', subtitle: 'Hardware wallet · BTC & ETH · xPub friendly', group: 'Hardware', chains: ['bitcoin', 'ethereum'], logo: `${ICONS}/trezor.png`, lightChip: true },
  { id: 'keepkey', name: 'KeepKey', subtitle: 'Hardware wallet', group: 'Hardware', chains: ['bitcoin'], logo: `${ICONS}/keepkey.png` },
  { id: 'coldcard', name: 'Coldcard', subtitle: 'Bitcoin hardware wallet', group: 'Hardware', chains: ['bitcoin'], logo: `${ICONS}/coldcard.png` },
  { id: 'onekey', name: 'OneKey', aliases: ['one key'], subtitle: 'Hardware wallet', group: 'Hardware', chains: ['bitcoin', 'ethereum'], logo: `${ICONS}/onekey.svg` },
  { id: 'keystone', name: 'Keystone', subtitle: 'Air-gapped hardware wallet', group: 'Hardware', chains: ['bitcoin', 'ethereum'], logo: `${ICONS}/keystone.ico` },
  { id: 'bitbox', name: 'BitBox02', aliases: ['bitbox'], subtitle: 'Hardware wallet', group: 'Hardware', chains: ['bitcoin', 'ethereum'], logo: `${ICONS}/bitbox.png`, lightChip: true },
  { id: 'secux', name: 'SecuX', subtitle: 'Hardware wallet', group: 'Hardware', chains: ['bitcoin', 'ethereum'], logo: `${ICONS}/secux.png` },
  { id: 'ellipal', name: 'Ellipal', subtitle: 'Air-gapped hardware wallet', group: 'Hardware', chains: ['bitcoin', 'ethereum'], logo: `${ICONS}/ellipal.png` },
  { id: 'tangem', name: 'Tangem', subtitle: 'Card-style hardware wallet', group: 'Hardware', chains: ['ethereum', 'bitcoin'], logo: `${ICONS}/tangem.png` },
  { id: 'dcent', name: "D'Cent", aliases: ['dcent'], subtitle: 'Biometric hardware wallet', group: 'Hardware', chains: ['ethereum', 'bitcoin'], logo: `${ICONS}/dcent.jpg`, lightChip: true },

  // ── Cosmos (addresses are not indexed by the lookup layer — manual chain pick) ──
  { id: 'leap', name: 'Leap', subtitle: 'Cosmos ecosystem wallet', group: 'Cosmos', chains: [], logo: `${ICONS}/leap.png` },
  { id: 'cosmostation', name: 'Cosmostation', subtitle: 'Cosmos ecosystem wallet', group: 'Cosmos', chains: [], logo: `${ICONS}/cosmostation.svg` },

  // ── Other chains ──
  { id: 'tronlink', name: 'TronLink', aliases: ['tron link'], subtitle: 'TRON ecosystem wallet', group: 'Other chains', chains: [], logo: `${ICONS}/tronlink.png` },
  { id: 'xaman', name: 'Xaman', aliases: ['xumm'], subtitle: 'XRP Ledger wallet', group: 'Other chains', chains: [], logo: `${ICONS}/xaman.png` },
  { id: 'veworld', name: 'VeWorld', subtitle: 'VeChain wallet', group: 'Other chains', chains: [], logo: `${ICONS}/veworld.png` },
  { id: 'terrastation', name: 'Terra Station', aliases: ['terra station wallet'], subtitle: 'Terra ecosystem wallet', group: 'Other chains', chains: [], logo: `${ICONS}/terrastation.svg` },
  { id: 'polkadotjs', name: 'Polkadot-JS', aliases: ['polkadot.js', 'polkadot js'], subtitle: 'Polkadot & Substrate', group: 'Other chains', chains: [], logo: `${ICONS}/polkadot.svg`, tile: '#E6007A' },
  { id: 'pontem', name: 'Pontem', subtitle: 'Aptos wallet', group: 'Other chains', chains: [], logo: `${ICONS}/pontem.png` },
  // Martian's site is defunct and no official repo ships a logo — letter chip (see SOURCES.md).
  { id: 'martian', name: 'Martian', subtitle: 'Aptos & Sui wallet', group: 'Other chains', chains: [] }
];

/** Look up a catalog wallet by id. */
export function getWalletApp(id: string): WalletCatalogEntry | undefined {
  return WALLET_CATALOG.find((w) => w.id === id);
}
