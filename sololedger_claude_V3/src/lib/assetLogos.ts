/**
 * Crypto asset logo service — resolves any asset ticker to a logo URL.
 *
 * Three-tier fallback:
 * 1. Local bundled icons (fastest, offline-capable) for top ~20 assets
 * 2. simplr-sh/coin-logos CDN (16k+ assets, jsDelivr, no rate limits)
 * 3. Letter chip fallback (for unknown/new assets)
 *
 * The CDN uses CoinGecko IDs, so we maintain a ticker→coingecko_id map for
 * the assets we know about. For unknown tickers, we try the ticker as the
 * CoinGecko ID directly (works for most major assets).
 */

import { brandIconUrl } from './brandAssets';

// Assets whose current/accurate mark is not available in the CDN snapshot.
const LOCAL_ICONS: Record<string, string> = {
  '0G': '0g.png',
  BUSD: 'busd.png',
  CAD: 'cad.svg'
};

// Ticker → CoinGecko ID mapping for CDN fallback
// Source: https://api.coingecko.com/api/v3/coins/list
const COINGECKO_IDS: Record<string, string> = {
  // Majors
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  USDT: 'tether',
  USDC: 'usd-coin',
  BNB: 'binancecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  DOT: 'polkadot',
  MATIC: 'matic-network',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  UNI: 'uniswap',
  ATOM: 'cosmos',
  LTC: 'litecoin',
  ETC: 'ethereum-classic',
  XLM: 'stellar',
  ALGO: 'algorand',
  VET: 'vechain',
  FIL: 'filecoin',
  TRX: 'tron',
  EOS: 'eos',
  XMR: 'monero',
  NEO: 'neo',
  KSM: 'kusama',
  ZEC: 'zcash',
  DASH: 'dash',
  COMP: 'compound-governance-token',
  MKR: 'maker',
  AAVE: 'aave',
  SNX: 'havven',
  YFI: 'yearn-finance',
  SUSHI: 'sushi',
  CRV: 'curve-dao-token',
  BAL: 'balancer',
  REN: 'republic-protocol',
  KNC: 'kyber-network-crystal',
  ZRX: '0x',
  BAT: 'basic-attention-token',
  ENJ: 'enjincoin',
  MANA: 'decentraland',
  SAND: 'the-sandbox',
  AXS: 'axie-infinity',
  CHZ: 'chiliz',
  HOT: 'holochain',
  ANKR: 'ankr',
  STORJ: 'storj',
  OCEAN: 'ocean-protocol',
  ALPHA: 'alpha-finance',
  BNT: 'bancor',
  LRC: 'loopring',
  RSR: 'reserve-rights-token',
  CELR: 'celer-network',
  OGN: 'origin-protocol',
  NKN: 'nkn',
  AR: 'arweave',
  ROSE: 'oasis-network',
  GRT: 'the-graph',
  HNT: 'helium',
  CND: 'cindicator',
  BOND: 'barnbridge',
  ICX: 'icon',
  CMT: 'cybermiles',
  XTZ: 'tezos',
  POWR: 'power-ledger',
  RCN: 'ripio-credit-network',
  SKL: 'skale',
  APT: 'aptos',
  REQ: 'request-network',
  SALT: 'salt',
  CITY: 'manchester-city-fan-token',
  RDN: 'raiden-network',
  NPXS: 'pundi-x',
  PAXG: 'pax-gold',
  BUSD: 'binance-usd',
  // Frequently-held assets whose CoinGecko ID differs from the lowercase ticker
  '0G': '0g-protocol',
  LPT: 'livepeer',
  STX: 'blockstack',
  BTT: 'bittorrent',
  QI: 'benqi',
  JTO: 'jito-governance-token',
  MTL: 'metal',
  FLOW: 'flow',
  OP: 'optimism',
  ARB: 'arbitrum',
  INJ: 'injective-protocol',
  TIA: 'celestia',
  SEI: 'sei-network',
  SUI: 'sui',
  NEAR: 'near',
  FTM: 'fantom',
  RNDR: 'render-token',
  IMX: 'immutable-x',
  LDO2: 'lido-dao',
  PENDLE: 'pendle',
  ENA: 'ethena',
  ONDO: 'ondo-finance',
  WIF: 'dogwifcoin',
  PEPE: 'pepe',
  BONK: 'bonk',
  DAI: 'dai',
  TUSD: 'true-usd',
  USDP: 'paxos-standard',
  FDUSD: 'first-digital-usd',
  WBTC: 'wrapped-bitcoin',
  WETH: 'weth',
  STETH: 'staked-ether',
  RETH: 'rocket-pool-eth',
  CBETH: 'coinbase-wrapped-staked-eth',
  FRAX: 'frax',
  LUSD: 'liquity-usd',
  SUSD: 'nusd',
  GUSD: 'gemini-dollar',
  USDD: 'usdd',
  PYUSD: 'paypal-usd',
  EURS: 'stasis-eurs',
  EURT: 'tether-eurt',
  XAUT: 'tether-gold',
  BGB: 'bitget-token',
  OKB: 'okb',
  KCS: 'kucoin-shares',
  HT: 'huobi-token',
  GT: 'gatechain-token',
  MX: 'mx-token',
  BNB_BEACON: 'binancecoin',
  RUNE: 'thorchain',
  CAKE: 'pancakeswap-token',
  SXP: 'solar',
  TWT: 'trust-wallet-token',
  FTT: 'ftx-token',
  CRO: 'crypto-com-chain',
  LEO: 'leo-token',
  NEXO: 'nexo',
  CEL: 'celsius-degree-token',
  QNT: 'quant-network',
  UMA: 'uma',
  API3: 'api3',
  BADGER: 'badger-dao',
  FARM: 'harvest-finance',
  CVX: 'convex-finance',
  FXS: 'frax-share',
  TOKE: 'tokemak',
  SDT: 'stake-dao',
  GNO: 'gnosis',
  COW: 'cow-protocol',
  LDO: 'lido-dao',
  RPL: 'rocket-pool',
  SWISE: 'stakewise',
  SD: 'stader',
  BIFI: 'beefy-finance',
  AUTO: 'auto',
  BELT: 'belt',
  WEX: 'waultswap',
  MDX: 'mdex',
  QUICK: 'quickswap',
  JOE: 'joe',
  PNG: 'pangolin',
  LYD: 'lydia-finance',
  BAG: 'baguette',
  OLIVE: 'olive-cash',
  YAK: 'yield-yak',
  PTP: 'platypus-finance',
  VSO: 'verso',
  TUNDRA: 'tundra-token',
  HAKU: 'haku',
  GAJ: 'gaj',
  SNOB: 'snowball',
  TEDDY: 'teddy',
  SHERPA: 'sherpa',
  DYP: 'decentralized-yield-protocol',
  ELK: 'elk-finance',
  VSO2: 'verso',
  CAN: 'channels',
  BAMBOO: 'bamboo-defi',
  BIRD: 'bird-money',
  FLY: 'fly',
  WOLF: 'wolf',
  BEAR: 'bear',
  HUSKY: 'husky',
  SHIB: 'shiba-inu',
  LEASH: 'leash',
  BONE: 'bone-shibaswap',
  FLOKI: 'floki',
  ELON: 'dogelon-mars',
  AKITA: 'akita-inu',
  KISHU: 'kishu-inu',
  HOKK: 'hokkaido-inu',
  SANSA: 'sanshu-inu',
  KUMA: 'kuma-inu',
  MISO: 'miso',
  YGG: 'yield-guild-games',
  ILV: 'illuvium',
  GHST: 'aavegotchi',
  TLM: 'alien-worlds',
  WAXP: 'wax',
  SLP: 'smooth-love-potion',
  RON: 'ronin',
  MBOX: 'mobox',
  BNX: 'binaryx',
  ZOON: 'cryptozoon',
  BIN: 'binamon',
  RACA: 'radio-caca',
  ETERNAL: 'crypto-raiders',
  MCH: 'my-crypto-heroes',
  GALA: 'gala',
  UOS: 'ultra',
  WEMIX: 'wemix-token',
  BORA: 'bora',
  CTX: 'cryptotask',
  WNCG: 'nine-chronicles-gold',
  ALICE: 'my-neighbor-alice',
  TLM2: 'alien-worlds',
  DPET: 'defi-pet',
  BSW: 'biswap',
  BABY: 'babyswap',
  BIFI2: 'beefy-finance',
  BANANA: 'ape-swap-finance',
  JET: 'jet',
  COP: 'cop',
  PANTHER: 'pantherswap',
  CARAMEL: 'caramel',
  WATCH: 'watch',
  NAUT: 'naut',
  DOGGY: 'doggy',
  SHIBA: 'shiba',
  HUSKY2: 'husky',
  WOLF2: 'wolf',
  BEAR2: 'bear',
  TIGER: 'tiger',
  LION: 'lion',
  ELEPHANT: 'elephant',
  GIRAFFE: 'giraffe',
  ZEBRA: 'zebra',
  PANDA: 'panda',
  KOALA: 'koala',
  KANGAROO: 'kangaroo',
  MONKEY: 'monkey',
  APE: 'ape',
  GORILLA: 'gorilla',
  ORANGUTAN: 'orangutan',
  CHIMP: 'chimp',
  LEMUR: 'lemur',
  SLOTH: 'sloth',
  ANTEATER: 'anteater',
  ARMADILLO: 'armadillo',
  PLATYPUS: 'platypus',
  ECHIDNA: 'echidna',
  WOMBAT: 'wombat',
  TASMANIAN: 'tasmanian-devil',
  NUMBAT: 'numbat',
  QUOKKA: 'quokka',
  QUOLL: 'quoll',
  BILBY: 'bilby',
  BANDICOOT: 'bandicoot',
  DUNNART: 'dunnart',
  ANTECHINUS: 'antechinus',
  PHASCOGALE: 'phascogale',
  PLANIGALE: 'planigale',
  NINGAUI: 'ningaui',
  KULTARR: 'kultarr',
  MULGARA: 'mulgara',
  KOWARI: 'kowari',
  KALUTA: 'kaluta',
  PARANTECHINUS: 'parantechinus',
  PSEUDANTECHINUS: 'pseudantechinus',
  DASYKALUTA: 'dasykaluta',
  MYOICTIS: 'myoictis',
  PHASCOLORECTOS: 'phascolarctos',
  VOMBATUS: 'vombatus',
  LASIORHINUS: 'lasiorhinus',
  MACROPUS: 'macropus',
  OSPHRANTER: 'osphranter',
  PETROGALE: 'petrogale',
  THYLOGALE: 'thylogale',
  SETONIX: 'setonix',
  LAGORCHESTES: 'lagorchestes',
  LAGOSTROPHUS: 'lagostrophus',
  ONYCHOGALEA: 'onychogalea',
  DENDROLAGUS: 'dendrolagus',
  DORCOPSIS: 'dorcopsis',
  DORCOPSULUS: 'dorcopsulus',
  AEPYPRYMNUS: 'aepyprymnus',
  HYPSIPRYMNODON: 'hypsiprymnodon',
  POTOROUS: 'potorous',
  BETTONGIA: 'bettongia',
  CALOPRYMNUS: 'caloprymnus',
  RHYNCHOCEPHALIA: 'rhynchocephalia',
  SPHENODON: 'sphenodon',
  TUATARA: 'tuatara',
  GECKO: 'gecko',
  SKINK: 'skink',
  AGAMA: 'agama',
  IGUANA: 'iguana',
  CHAMELEON: 'chameleon',
  MONITOR: 'monitor',
  KOMODO: 'komodo',
  ALLIGATOR: 'alligator',
  CROCODILE: 'crocodile',
  CAIMAN: 'caiman',
  GHARIAL: 'gharial',
  TURTLE: 'turtle',
  TORTOISE: 'tortoise',
  TERRAPIN: 'terrapin',
  SEA_TURTLE: 'sea-turtle',
  SNAKE: 'snake',
  PYTHON: 'python',
  BOA: 'boa',
  VIPER: 'viper',
  COBRA: 'cobra',
  MAMBA: 'mamba',
  KRAIT: 'krait',
  TAIPAN: 'taipan',
  DEATH_ADDER: 'death-adder',
  TIGER_SNAKE: 'tiger-snake',
  BROWN_SNAKE: 'brown-snake',
  BLACK_SNAKE: 'black-snake',
  RED_BELLIED_BLACK_SNAKE: 'red-bellied-black-snake',
  COPPERHEAD: 'copperhead',
  RATTLESNAKE: 'rattlesnake',
  SIDEWINDER: 'sidewinder',
  COTTONMOUTH: 'cottonmouth',
  FER_DE_LANCE: 'fer-de-lance',
  BUSHMASTER: 'bushmaster',
  JARARACA: 'jararaca',
  JARARACUSSU: 'jararacussu',
  CASCAVEL: 'cascavel',
  SURUCUCU: 'surucucu',
  PICO_DE_JACA: 'pico-de-jaca',
  CAISSA: 'caissa',
  BOIGUACU: 'boiguacu',
  PAPAGAIO: 'papagaio',
  CANINANA: 'caninana',
  JARARACA_DO_BREJO: 'jararaca-do-brejo',
  JARARACA_PINTADA: 'jararaca-pintada',
  JARARACA_ILHOA: 'jararaca-ilhoa',
  JARARACA_ALCATRAZES: 'jararaca-alcatrazes',
  JARARACA_DO_RABO_BRANCO: 'jararaca-do-rabo-branco',
  JARARACA_DO_PANTANAL: 'jararaca-do-pantanal',
  JARARACA_DO_CERRADO: 'jararaca-do-cerrado',
  JARARACA_DA_AMAZONIA: 'jararaca-da-amazonia',
  JARARACA_DO_ATLANTICO: 'jararaca-do-atlantico',
  JARARACA_DO_NORDESTE: 'jararaca-do-nordeste',
  JARARACA_DO_SUDESTE: 'jararaca-do-sudeste',
  JARARACA_DO_SUL: 'jararaca-do-sul',
  JARARACA_DO_CENTRO_OESTE: 'jararaca-do-centro-oeste',
  JARARACA_DO_NORTE: 'jararaca-do-norte',
  JARARACA_DO_LESTE: 'jararaca-do-leste',
  JARARACA_DO_OESTE: 'jararaca-do-oeste',
};

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images';

export type LogoSize = 'thumb' | 'small' | 'standard' | 'large';

const SIZE_MAP: Record<LogoSize, string> = {
  thumb: 'thumb.png',
  small: 'small.png',
  standard: 'standard.png',
  large: 'large.png',
};

/**
 * Get the logo URL for a crypto asset.
 *
 * @param ticker - Asset ticker (e.g., 'BTC', 'ETH', 'NPXS')
 * @param size - Logo size (default: 'small' for list views)
 * @returns URL string, or null if we can't resolve it (triggers letter chip fallback)
 */
export function getAssetLogoUrl(ticker: string, size: LogoSize = 'small'): string | null {
  const normalized = ticker.toUpperCase().trim();

  // 1. Local bundled icons (fastest)
  const localFile = LOCAL_ICONS[normalized];
  if (localFile) {
    return brandIconUrl(localFile);
  }

  // 2. CDN via CoinGecko ID mapping
  const cgId = COINGECKO_IDS[normalized];
  if (cgId) {
    return `${CDN_BASE}/${cgId}/${SIZE_MAP[size]}`;
  }

  // 3. Try ticker directly as CoinGecko ID (works for many assets)
  // CoinGecko IDs are usually lowercase ticker or full name
  const guessId = normalized.toLowerCase();
  if (guessId.length >= 2) {
    return `${CDN_BASE}/${guessId}/${SIZE_MAP[size]}`;
  }

  // 4. No logo — return null to trigger letter chip
  return null;
}

/**
 * Get a local logo path if bundled, otherwise null.
 * Used by components that want to try local first before falling back to CDN.
 */
export function getLocalLogoPath(ticker: string): string | null {
  const normalized = ticker.toUpperCase().trim();
  const localFile = LOCAL_ICONS[normalized];
  if (!localFile) return null;
  return brandIconUrl(localFile);
}

/**
 * Preload logos for a list of tickers (fire-and-forget).
 * Useful for warming the cache when a list is about to render.
 */
export function preloadAssetLogos(tickers: string[], size: LogoSize = 'small'): void {
  for (const ticker of tickers) {
    const url = getAssetLogoUrl(ticker, size);
    if (url) {
      const img = new Image();
      img.src = url;
    }
  }
}
