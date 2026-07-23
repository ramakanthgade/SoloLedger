/**
 * Auto-sync exchange catalog (Section C, task 1) — mirrors importSources.ts.
 *
 * The five exchanges supported by Exchange Auto-Sync (contract C3/C5): the
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
  }
];

export function getAutoSyncExchange(id: string | null): AutoSyncExchange | undefined {
  if (!id) return undefined;
  return AUTO_SYNC_EXCHANGES.find((e) => e.id === id);
}
