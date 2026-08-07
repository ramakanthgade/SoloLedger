/**
 * Auto-sync exchange catalog (Section C, task 1) — mirrors importSources.ts.
 *
 * The exchanges supported by Exchange Auto-Sync (contract C3/C5): the
 * `id` IS the ccxt exchange id, `needsPassphrase` is true ONLY for OKX and
 * KuCoin (their `requiredCredentials` include `password`), and each entry
 * carries plain-language instructions for creating a READ-ONLY API key plus
 * a link to the exchange's API-key page.
 */
import type { ExchangeId } from '@/lib/exchangeSync';

export interface AutoSyncExchange {
  /** ccxt exchange id (contract C3 `ExchangeId`). */
  id: ExchangeId;
  label: string;
  /** Two-letter monogram for the Aurora logo tile. */
  monogram: string;
  /** OKX and KuCoin keys carry an extra user-chosen passphrase. */
  needsPassphrase: boolean;
  /** Short credential hint shown under the name in the picker. */
  formatHint: string;
  /** Ordered, plain-language steps to create a read-only key. */
  keyInstructions: string[];
  /** Breadcrumb path of the API-key page (e.g. Account › API Management). */
  path: string[];
  /** The exchange's own API-key / docs page. */
  docsUrl: string;
}

export const AUTO_SYNC_EXCHANGES: AutoSyncExchange[] = [
  {
    id: 'binance',
    label: 'Binance',
    monogram: 'BN',
    needsPassphrase: false,
    formatHint: 'API key + secret',
    keyInstructions: [
      'Log in to Binance on the web and open Account → API Management.',
      'Create a new API key (System Generated) and complete the security checks.',
      'Open Edit restrictions and tick only Enable Reading. Never enable trading or withdrawals.',
      'Copy the API Key and Secret Key and paste them here.'
    ],
    path: ['Binance', 'Account', 'API Management', 'Create API'],
    docsUrl: 'https://www.binance.com/en/my/settings/api-management'
  },
  {
    id: 'coinbase',
    label: 'Coinbase',
    monogram: 'CB',
    needsPassphrase: false,
    formatHint: 'API key + secret',
    keyInstructions: [
      'Log in to Coinbase and open Settings → API (Advanced Trade keys).',
      'Create a new API key for your portfolio.',
      'Keep the read-only View permission. Never add Trade or Transfer permissions.',
      'Copy the API Key and Secret and paste them here.'
    ],
    path: ['Coinbase', 'Settings', 'API', 'New API Key'],
    docsUrl: 'https://cloud.coinbase.com/access/api'
  },
  {
    id: 'kraken',
    label: 'Kraken',
    monogram: 'KR',
    needsPassphrase: false,
    formatHint: 'API key + secret',
    keyInstructions: [
      'Log in to Kraken and open Settings → Security → API.',
      'Add a new key.',
      'Tick only the Query permissions (Query Funds, Query Open Orders & Trades, Query Closed Orders & Trades, Query Ledger Entries). Never enable trading or withdrawals.',
      'Copy the API Key and Private Key and paste them here.'
    ],
    path: ['Kraken', 'Settings', 'Security', 'API'],
    docsUrl: 'https://www.kraken.com/u/security/api'
  },
  {
    id: 'okx',
    label: 'OKX',
    monogram: 'OK',
    needsPassphrase: true,
    formatHint: 'Also needs a passphrase',
    keyInstructions: [
      'Log in to OKX and open your profile → API.',
      'Create a new API key and set a Passphrase — you chose it, and you need it here too.',
      'Tick only the Read permission. Never enable Trade or Withdraw.',
      'Copy the API Key, Secret Key and your Passphrase and paste them here.'
    ],
    path: ['OKX', 'Profile', 'API', 'Create API Key'],
    docsUrl: 'https://www.okx.com/account/my-api'
  },
  {
    id: 'kucoin',
    label: 'KuCoin',
    monogram: 'KC',
    needsPassphrase: true,
    formatHint: 'Also needs a passphrase',
    keyInstructions: [
      'Log in to KuCoin and open Profile → API Management.',
      'Create a new API and set an API Passphrase — you chose it, and you need it here too.',
      'When KuCoin asks for permissions, tick only General / Read. Never enable trading or withdrawals.',
      'Copy the Key, Secret and your Passphrase and paste them here.'
    ],
    path: ['KuCoin', 'Profile', 'API Management', 'Create API'],
    docsUrl: 'https://www.kucoin.com/account/api'
  },
  {
    id: 'bybit',
    label: 'Bybit',
    monogram: 'BB',
    needsPassphrase: false,
    formatHint: 'API key + secret',
    keyInstructions: [
      'Log in to Bybit on the web and open Account → API Management.',
      'Create a System-generated API Key for API Transactions.',
      'Create the key under the master account / master UID. Bybit exposes withdrawal history only to a master-account key; subaccount keys cannot provide complete withdrawal coverage.',
      'Choose Read-Only and enable the assets and spot order/history permissions needed to view balances, deposits, withdrawals and spot executions. Never enable trading or withdrawals.',
      'Copy the API Key and API Secret and paste them here.'
    ],
    path: ['Bybit', 'Account', 'API Management', 'Create New Key'],
    docsUrl: 'https://www.bybit.com/app/user/api-management'
  },
  {
    id: 'gateio',
    label: 'Gate.io',
    monogram: 'GT',
    needsPassphrase: false,
    formatHint: 'API key + secret',
    keyInstructions: [
      'Log in to Gate.io on the web and open Profile → API Management → Sub account and API → APIv4 Keys.',
      'Create a new APIv4 key and give it a recognizable name.',
      'Enable read-only access for Spot / Account and Wallet history only. Never enable trading, withdrawals, margin or futures permissions.',
      'Copy the API Key and API Secret and paste them here. Gate.io does not require a passphrase.'
    ],
    path: ['Gate.io', 'Profile', 'API Management', 'APIv4 Keys'],
    docsUrl: 'https://www.gate.io/myaccount/api_key_manage'
  },
  {
    id: 'htx',
    label: 'HTX',
    monogram: 'HX',
    needsPassphrase: false,
    formatHint: 'API key + secret',
    keyInstructions: [
      'Log in to HTX on the web and open Profile → API Management.',
      'Create a new API key and give it a recognizable note.',
      'Select Read-only only. Never enable trading, withdrawals, margin, futures or contract permissions.',
      'Copy the Access Key and Secret Key and paste them here. HTX does not require a passphrase.'
    ],
    path: ['HTX', 'Profile', 'API Management', 'Create API Key'],
    docsUrl: 'https://www.htx.com/apikey'
  },
  {
    id: 'cryptocom',
    label: 'Crypto.com Exchange',
    monogram: 'CX',
    needsPassphrase: false,
    formatHint: 'Exchange API key + secret',
    keyInstructions: [
      'Open Crypto.com Exchange on the web (not the Crypto.com App) and go to Settings → API Keys.',
      'Create an Exchange API key and enable read-only access for balances and transaction history.',
      'Never enable trading, transfers or withdrawals. Crypto.com Exchange does not require an API passphrase.',
      'Balances returned by this connection cover the whole Exchange account, not a complete spot-only subledger. SoloLedger uses them to validate the connection but does not replace history-derived holdings with them.',
      'Copy the API Key and Secret Key and paste them here. App CSV exports are a separate import source and do not backfill Exchange API history.'
    ],
    path: ['Crypto.com Exchange', 'Settings', 'API Keys', 'Create read-only key'],
    docsUrl: 'https://crypto.com/exchange/user/settings/api-management'
  },
  {
    id: 'bitfinex',
    label: 'Bitfinex',
    monogram: 'BF',
    needsPassphrase: false,
    formatHint: 'API key + secret · retention-limited beta',
    keyInstructions: [
      'Log in to Bitfinex and open Account → API Keys, then create a new key.',
      'Enable read-only access for wallets, account history and orders/trades only. Never enable trading, transfers or withdrawals.',
      'Copy the API Key and API Secret and paste them here. Bitfinex does not require a passphrase.',
      'Retention beta: Trades API history is approximately 7 days and Movements API history is approximately 90 days. Older activity needs an export or other records.',
      'The existing CSV beta supports the Trades schema only. It cannot backfill Movements, and API↔CSV trade ID parity is unverified, so SoloLedger does not auto-deduplicate Bitfinex API rows with CSV rows.'
    ],
    path: ['Bitfinex', 'Account', 'API Keys', 'Create New Key'],
    docsUrl: 'https://setting.bitfinex.com/api'
  },
  {
    id: 'gemini',
    label: 'Gemini',
    monogram: 'GM',
    needsPassphrase: false,
    formatHint: 'Account API key + secret',
    keyInstructions: [
      'Log in to Gemini on the web and open Account → Settings → API.',
      'Create an account-level API key, not a master key, and select the Auditor role.',
      'Auditor is read-only. Never enable trading, Fund Manager access or withdrawals.',
      'Copy the API Key and API Secret and paste them here. Gemini does not require a passphrase.'
    ],
    path: ['Gemini', 'Account', 'Settings', 'API', 'Create API Key'],
    docsUrl: 'https://exchange.gemini.com/settings/api'
  }
];

export function getAutoSyncExchange(id: string | null): AutoSyncExchange | undefined {
  if (!id) return undefined;
  return AUTO_SYNC_EXCHANGES.find((e) => e.id === id);
}
