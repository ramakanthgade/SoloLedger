import type { LedgerStitchConfig } from './ledgerStitch';

/**
 * Binance "Transaction History" export — declarative operation map for the
 * generic ledger-stitching engine. Every operation string verified against the
 * real 28,928-row export (2017 → 2026). Adding support for another exchange's
 * full-ledger export = writing another one of these configs, NOT a stitcher.
 */
export const binanceLedgerConfig: LedgerStitchConfig = {
  exchange: 'binance',
  columns: {
    operation: ['operation'],
    coin: ['coin'],
    change: ['change'],
    time: ['utctime', 'time', 'datetime'],
    account: ['account'],
    remark: ['remark'],
    orderId: ['orderid', 'orderno', 'ordernumber', 'tradeid', 'txid', 'transactionid']
  },
  defaultAccount: 'Spot',
  ops: {
    // Modern-era spot triplets.
    tradeBuy: ['Transaction Buy'],
    spendOps: ['Transaction Spend'],
    tradeSell: ['Transaction Sold'],
    revenueOps: ['Transaction Revenue'],
    tradeFee: ['Transaction Fee'],
    // OLD-era (2017-2021) simple trades.
    simpleTrade: { buy: ['Buy'], sell: ['Sell'], fee: ['Fee'] },
    // Two-leg swaps.
    convert: [
      'Binance Convert',
      'Stablecoins Auto-Conversion',
      'Futures Convert - From',
      'Futures Convert - To',
      'Token Swap - Redenomination/Rebranding'
    ],
    dustConvert: { ops: ['Small Assets Exchange BNB'], toAsset: 'BNB' },
    fiatConvert: ['Transaction Related'],
    deposit: ['Deposit'],
    withdraw: ['Withdraw'],
    income: [
      'Staking Rewards',
      'POS Savings Interest',
      'Savings Interest',
      'Commission History',
      'Distribution',
      'Cash Voucher Distribution',
      'Airdrop',
      'Airdrop Assets',
      'Referral Commission',
      'Launchpool Interest',
      'Commission Rebate',
      'Referee Commission',
      'Launchpool Airdrop - User Claim Distribution',
      'Campaign Related Reward',
      'Token Swap - Distribution',
      // Positive legs are 2017-2019 airdrops; negative legs fall through to
      // transfer_out (sign-aware in the engine).
      'Asset - Transfer'
    ],
    internalTransfer: [
      'Transfer Between Spot and Funding',
      'Transfer Between Spot and CM Futures',
      'Transfer Between Spot and UM Futures',
      'Transfer Between Spot and Options',
      'Transfer Between UM Futures and Options',
      'Transfer'
    ],
    internalTransferExclude: ['Inter-Wallet Transfer'],
    signSplit: [
      { op: 'Realized Profit and Loss', negativeType: 'sell', category: 'perp', derivative: true },
      { op: 'Funding Fee', negativeType: 'fee', category: 'perp', derivative: true }
    ],
    fiatWithdraw: ['Fiat Withdraw'],
    skip: [
      'Launchpool Subscription/Redemption', // principal lock/unlock
      'Margin Loan', // loan principal is not a taxable event
      'Margin Loan Repayment',
      'Cross Margin Liquidation - Repayment' // forced repayment: balance event only
    ],
    // Clawback / balance-reversal: a NEGATIVE leg reverses a prior credit
    // (airdrop/distribution) and must subtract or the credit survives as a
    // phantom (the NFT +44,680 case). Positive legs are skipped in the engine.
    clawback: ['Asset Recovery'],
    p2p: { ops: ['P2P Trading'], withdrawOpsWithP2pRemark: ['Withdraw'] }
  }
};
