/**
 * Core domain model. Every parser (Coinbase, Binance, manual entry, RPC lookup)
 * normalizes into this single shape so the calculation engine never needs to
 * know where data came from.
 */

export type TxType =
  | 'buy'          // acquired asset via fiat purchase
  | 'sell'         // disposed of asset for fiat
  | 'trade'        // asset-for-asset swap (disposal of one, acquisition of other)
  | 'transfer_in'  // moved into a wallet/exchange you own (non-taxable)
  | 'transfer_out' // moved out to a wallet/exchange you own (non-taxable)
  | 'income'       // staking reward, airdrop, mining, interest — taxable as income at FMV
  | 'gift_sent'
  | 'gift_received'
  | 'fee'          // network/exchange fee paid in crypto
  | 'nft_mint'
  | 'nft_buy'
  | 'nft_sell'
  | 'defi_deposit' // e.g. LP deposit / lending deposit
  | 'defi_withdraw'
  | 'other';

export type FlagReason =
  | 'possible_internal_transfer'
  | 'missing_cost_basis'
  | 'duplicate_suspected'
  | 'unrecognized_asset'
  | 'needs_review';

export interface Transaction {
  id: string;                 // stable local id (uuid), never sent anywhere
  timestamp: number;          // epoch ms, UTC
  type: TxType;
  asset: string;               // e.g. "BTC", "ETH"
  amount: number;               // absolute quantity of `asset` moved
  feeAsset?: string;
  feeAmount?: number;
  fiatCurrency: string;         // user's reporting currency, e.g. "INR", "USD"
  fiatValue?: number;           // value of the amount at time of tx, in fiatCurrency
                                 // (required for buy/sell/trade/income; optional for transfers)
  counterAsset?: string;        // for trades: the asset received/given in exchange
  counterAmount?: number;
  source: string;               // "coinbase" | "binance" | "manual" | "rpc:<chain>" etc.
  sourceRef?: string;           // original row id / tx hash from the source, for audit trail
  walletAddress?: string;       // the queried address this row belongs to (RPC lookups)
  counterpartyAddress?: string; // the other side of a transfer, when derivable
  contractAddress?: string;     // token contract (EVM) or mint address (Solana), for price lookups
  chain?: string;               // originating chain id for RPC-sourced rows, e.g. "ethereum", "solana"
  notes?: string;
  flags: FlagReason[];
  isInternalTransfer: boolean;  // user-confirmed non-taxable transfer between own wallets
  isSpam?: boolean;             // user-confirmed spam/phishing — excluded from all calculations
  category?: string;            // user-editable free-form tag
  /**
   * Spot vs derivatives (perps/futures). Set by exchange parsers (e.g. Hyperliquid).
   * Undefined → treated as spot unless source/category heuristics say otherwise.
   */
  instrumentClass?: 'spot' | 'derivative';
  importBatchId?: string;       // links row to a CSV import batch (file hash)
  /**
   * India TDS (Section 194S — 1% on VDA transfers) withheld on this transaction.
   * Captured structurally so it can be reconciled FY-by-FY. All optional/additive:
   * rows imported before this existed simply leave them undefined.
   */
  tdsAmount?: number;           // quantity of `tdsAsset` withheld (e.g. 0.0001 BTC or 5 INR)
  tdsAsset?: string;            // asset the TDS was taken in, e.g. "INR", "USDT", "BTC"
  tdsInr?: number;              // TDS value in INR when derivable (from the export or a fiat leg)
  raw?: Record<string, unknown>; // original parsed row, kept for traceability/debugging only
}

export interface Lot {
  id: string;
  asset: string;
  acquiredAt: number;
  amountRemaining: number;
  amountOriginal: number;
  costBasisPerUnit: number;    // in reporting fiat currency
  costBasisTotal: number;
  sourceTxId: string;
  acquisitionType: Extract<TxType, 'buy' | 'trade' | 'income' | 'gift_received' | 'nft_mint' | 'nft_buy'>;
}

export interface Disposal {
  id: string;
  asset: string;
  disposedAt: number;
  amount: number;
  proceeds: number;             // fiat value received
  costBasis: number;            // matched from consumed lot(s)
  gain: number;                 // proceeds - costBasis
  holdingPeriodDays: number;
  lotConsumption: { lotId: string; amount: number; costBasis: number }[];
  sourceTxId: string;
  method: 'FIFO' | 'LIFO' | 'HIFO' | 'SpecID';
}

export type Jurisdiction = 'IN' | 'US' | 'CA' | 'AE';

/** How derivative (perp/futures) PnL is presented in Capital Gains / Reports. */
export type DerivativesTreatment = 'business_income' | 'capital_gains';

export interface TaxSettings {
  jurisdiction: Jurisdiction;
  reportingCurrency: string;   // "INR", "USD", "CAD", "AED"
  defaultCostBasisMethod: 'FIFO' | 'LIFO' | 'HIFO' | 'SpecID';
  /**
   * Tax presentation for derivatives. When unset, defaults from jurisdiction
   * (IN/CA → business_income, US/AE → capital_gains). Applied at report time.
   */
  derivativesTreatment?: DerivativesTreatment;
  priceApiEnabled: boolean;
  rpcLookupEnabled: boolean;
  /** One Alchemy key covers Ethereum + every EVM chain it supports + Solana. */
  alchemyApiKey?: string;
  /** CoinGecko Pro key — historical prices by date (recommended for 100+ tx imports). */
  coingeckoApiKey?: string;
  /** Birdeye key — historical token prices for Solana long-tail tokens via DEX pools. */
  birdeyeApiKey?: string;
  /** Noves key — DeFi/swap/staking classification for EVM + Solana tx hashes. */
  novesApiKey?: string;
  /**
   * Helius API key — primary Solana data source.
   * Returns pre-parsed, labeled transactions (SWAP, STAKE, NFT_SALE, etc.) including
   * Jupiter DCA fills with exact token amounts. Replaces raw Alchemy Solana import.
   * Get one free at https://dev.helius.xyz/
   */
  heliusApiKey?: string;
  /**
   * Moralis API key — primary EVM data source.
   * Returns decoded, categorized transactions with spam detection across 30+ chains.
   * Get one at https://moralis.io/
   */
  moralisApiKey?: string;
  /** OpenRouter API key — used for the AI Tax Advisor chat panel. */
  aiApiKey?: string;
  /** OpenRouter model id, e.g. anthropic/claude-opus-4-5 */
  aiModel?: string;
  /**
   * First-use consent for the AI Tax Advisor (A2). Off by default — the AI
   * Advisor is the one feature that sends data off-device (an aggregated
   * summary + the typed question), so no AI request runs until the user
   * explicitly opts in. Stored via the existing settings persistence — no
   * Dexie schema bump. Revocable any time from Settings → AI Advisor.
   */
  aiConsentGranted?: boolean;
  /** For the "other EVM chain" manual fallback in wallet lookup. */
  customExplorerBaseUrl?: string;
  customExplorerApiKey?: string;
  /**
   * On-device Ed25519-signed license key (D6). Bearer credential stored as-is
   * via the existing settings persistence (no Dexie schema bump). Re-verified
   * on load by `src/lib/billing/license.ts`.
   */
  licenseKey?: string;
}

export interface TaxYearSummary {
  year: number;
  jurisdiction: Jurisdiction;
  totalProceeds: number;
  totalCostBasis: number;
  totalGain: number;
  shortTermGain?: number;   // where jurisdiction distinguishes holding periods
  longTermGain?: number;
  /** Sum of positive-gain consumed lots (gross gains, before any offset). */
  totalGains?: number;
  /** Sum of the magnitudes of negative-gain consumed lots (gross losses). */
  totalLosses?: number;
  /**
   * Losses that cannot offset gains under the jurisdiction's rules (India,
   * Section 115BBH). 0/undefined where losses may offset gains.
   */
  disallowedLosses?: number;
  /** Capital-gains inclusion rate (e.g. CA 0.5). Undefined where not applicable. */
  inclusionRate?: number;
  /** Non-advice estimated tax (e.g. India VDA 30% + 4% cess). */
  estimatedTax?: number;
  /**
   * DEPRECATED / never raised as of B9a. Previously flagged India income/gift/
   * airdrop VDA lots as having receipt-side treatment that was not yet modelled.
   * The treatment is now VALIDATED from primary sources (Section 115BBH(2)(a)
   * cost-of-acquisition-only + Section 56(2)(x) FMV-at-receipt-as-income), so it
   * is always false for IN. Field kept (additive) for back-compat consumers.
   */
  incomeGiftTreatmentLimited?: boolean;
  /**
   * India Section 56(2)(x): total FMV-at-receipt (in reporting fiat) of
   * income/gift/airdrop/staking VDA events in the financial year. This is income
   * from other sources taxed at the recipient's SLAB rate — separate from the
   * 30% + 4% cess on VDA transfers (Section 115BBH). Reports surface it as its
   * own line; slab-rate tax is out of scope (depends on total income).
   */
  vdaReceiptIncome?: number;
  totalIncome: number;      // staking/airdrop/mining etc. valued at FMV
  /** Derivatives business income (profits) when treatment = business_income. */
  derivativesIncome?: number;
  /** Derivatives business expenses (fees + losses) when treatment = business_income. */
  derivativesExpenses?: number;
  disposalsCount: number;
  byAsset: Record<string, { proceeds: number; costBasis: number; gain: number }>;
}
