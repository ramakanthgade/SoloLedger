/**
 * Auto-sync exchange catalog (Section C, task 1) — mirrors importSources.ts.
 *
 * The exchanges supported by Exchange Auto-Sync (contract C3/C5): the
 * `id` IS the ccxt exchange id, `needsPassphrase` is true only where CCXT
 * requires `password` (OKX, KuCoin, Bitget), and each entry
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
  },
  {
    id: 'btcmarkets',
    label: 'BTC Markets',
    monogram: 'BM',
    needsPassphrase: false,
    formatHint: 'API key + base64 secret',
    keyInstructions: [
      'Log in to BTC Markets on the web and open Account → API Key.',
      'Create a key with only the read permissions needed for balances, trades and fund-transfer history.',
      'Never enable order placement, trading or withdrawal permissions.',
      'Copy the API Key and base64 Secret and paste them here. BTC Markets does not require a passphrase.',
      'API retention is undocumented. SoloLedger backfills until the endpoint is exhausted but cannot verify account-lifetime coverage. There is no BTC Markets CSV parser, so CSV/API deduplication is unavailable.'
    ],
    path: ['BTC Markets', 'Account', 'API Key', 'Create API Key'],
    docsUrl: 'https://support.btcmarkets.net/hc/en-us/articles/360046326934-How-to-Access-and-Generate-Revoke-Your-API-Keys'
  },
  {
    id: 'mexc',
    label: 'MEXC',
    monogram: 'MX',
    needsPassphrase: false,
    formatHint: 'API key + secret · retention-limited beta',
    keyInstructions: [
      'Log in to MEXC on the web and open Profile → API Management.',
      'Create an API key with read access for spot account, spot trade history, and deposit/withdrawal history only. Never enable trading, withdrawals, internal transfer, margin, futures, broker, or contract permissions.',
      'Copy the Access Key and Secret Key and paste them here. MEXC does not require a passphrase.',
      'MEXC API trade history covers only the last month; deposit and withdrawal API history covers only the last 90 days. This is not lifetime coverage.',
      'Export older records from the MEXC website (trade exports support up to 540 days per MEXC documentation). SoloLedger has no MEXC CSV parser and makes no API/CSV deduplication promise.'
    ],
    path: ['MEXC', 'Profile', 'API Management', 'Create API'],
    docsUrl: 'https://www.mexc.com/user/openapi'
  },
  {
    id: 'bitvavo',
    label: 'Bitvavo',
    monogram: 'BV',
    needsPassphrase: false,
    formatHint: 'API key + secret · permission caveat',
    keyInstructions: [
      'Log in to Bitvavo on the web and open Settings → API, then add a new API key.',
      'Enable View information and Trade digital assets. Bitvavo requires both permissions even to retrieve trade history.',
      'Never enable Withdraw digital assets. SoloLedger’s relay is GET-only and cannot place/cancel orders or withdraw assets.',
      'Copy the 64-character API Key and API Secret and paste them here. Bitvavo does not require a passphrase.',
      'Coverage uses Bitvavo account history as an activity index, then imports native fills and specialized deposit/withdrawal history. Price Guarantee or other buy/sell activity not represented by fills is retained from account history without guessing its product label.',
      'A first sync cannot discover activity omitted by account history or markets delisted before that sync. SoloLedger never claims account-lifetime completeness, and does not claim API↔CSV deduplication.'
    ],
    path: ['Bitvavo', 'Settings', 'API', 'Add new API key'],
    docsUrl: 'https://support.bitvavo.com/hc/en-us/articles/4405059841809-What-are-API-keys-and-how-do-I-create-them'
  },
  {
    id: 'bitstamp',
    label: 'Bitstamp',
    monogram: 'BS',
    needsPassphrase: false,
    formatHint: 'API key + secret',
    keyInstructions: [
      'Log in to Bitstamp on the web and open Settings → API access.',
      'Create a read-only key with only account balance and transaction-history permissions. Never enable trading or withdrawals.',
      'Copy the 32-character API Key and Secret and paste them here. Bitstamp does not require a passphrase.',
      'SoloLedger uses Bitstamp’s native since_id continuation instead of the 200,000 offset-limited export path. The API publishes no account-lifetime retention guarantee; endpoint exhaustion proves only the history Bitstamp returned.',
      'Auto-sync imports active spot trades and settled deposits/withdrawals. Staking, rewards, sub-account, conversion, simple-buy and other mixed-ledger activity remains explicitly partial and requires a Bitstamp CSV export or manual records.'
    ],
    path: ['Bitstamp', 'Settings', 'API access', 'New API key'],
    docsUrl: 'https://www.bitstamp.net/account/security/api/'
  },
  {
    id: 'bitget',
    label: 'Bitget',
    monogram: 'BG',
    needsPassphrase: true,
    formatHint: 'API key + secret + passphrase · 90-day API coverage',
    keyInstructions: [
      'Log in to Bitget on the web and open Profile → API Management.',
      'Create a system-generated API key and set an API Passphrase — you chose it, and you need it here too.',
      'Enable Read-only for Spot account, spot trade history, and deposit/withdrawal history. Never enable trading, transfers, or withdrawals.',
      'Copy the API Key, Secret Key, and Passphrase and paste them here.',
      'Bitget documents 90 days of history on these API surfaces. Before it expires, retain Bitget Spot order/fill and deposit/withdrawal exports for older tax records. Export IDs are not verified to match API IDs, so SoloLedger keeps API dedup scoped to this connection and does not promise CSV auto-deduplication.'
    ],
    path: ['Bitget', 'Profile', 'API Management', 'Create API Key'],
    docsUrl: 'https://www.bitget.com/account/api'
  }
];

export function getAutoSyncExchange(id: string | null): AutoSyncExchange | undefined {
  if (!id) return undefined;
  return AUTO_SYNC_EXCHANGES.find((e) => e.id === id);
}
