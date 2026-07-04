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
  category?: string;            // user-editable free-form tag
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
  acquisitionType: Extract<TxType, 'buy' | 'trade' | 'income' | 'gift_received' | 'nft_mint'>;
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
  method: 'FIFO' | 'SpecID';
}

export type Jurisdiction = 'IN' | 'US' | 'CA' | 'AE';

export interface TaxSettings {
  jurisdiction: Jurisdiction;
  reportingCurrency: string;   // "INR", "USD", "CAD", "AED"
  defaultCostBasisMethod: 'FIFO' | 'SpecID';
  priceApiEnabled: boolean;
  rpcLookupEnabled: boolean;
  /** One Alchemy key covers Ethereum + every EVM chain it supports + Solana. */
  alchemyApiKey?: string;
  /** For the "other EVM chain" manual fallback in wallet lookup. */
  customExplorerBaseUrl?: string;
  customExplorerApiKey?: string;
}

export interface TaxYearSummary {
  year: number;
  jurisdiction: Jurisdiction;
  totalProceeds: number;
  totalCostBasis: number;
  totalGain: number;
  shortTermGain?: number;   // where jurisdiction distinguishes holding periods
  longTermGain?: number;
  totalIncome: number;      // staking/airdrop/mining etc. valued at FMV
  disposalsCount: number;
  byAsset: Record<string, { proceeds: number; costBasis: number; gain: number }>;
}
