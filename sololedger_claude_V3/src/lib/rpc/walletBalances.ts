/**
 * Live wallet balance fetcher — used by the Portfolio tab for current-period holdings.
 *
 * Design rationale:
 *   - Current FY: query the blockchain directly → always matches Phantom/MetaMask.
 *   - Historical FY: calculate from transaction history (only option for point-in-time).
 *   - Cross-validate: show "✓ matches wallet" or "△ X% variance" on Portfolio.
 *
 * Sources: Helius (Solana), Moralis (EVM), Alchemy fallback.
 */

import { resolveSolanaMintSymbol } from '@/lib/assets/solanaMints';

export interface TokenBalance {
  asset: string;
  amount: number;
  contractAddress?: string;
  chain: string;
  walletAddress: string;
}

export interface WalletBalancesConfig {
  heliusApiKey?: string;
  moralisApiKey?: string;
  alchemyApiKey?: string;
}

export const MORALIS_CHAIN_SLUG: Record<string, string> = {
  ethereum: 'eth', polygon: 'polygon', arbitrum: 'arbitrum', base: 'base',
  bsc: 'bsc', optimism: 'optimism', avalanche: 'avalanche'
};

const MORALIS_CHAIN_NATIVE: Record<string, string> = {
  eth: 'ETH', polygon: 'MATIC', arbitrum: 'ETH', base: 'ETH',
  bsc: 'BNB', optimism: 'ETH', avalanche: 'AVAX'
};

// ─── Helius / Alchemy Solana ────────────────────────────────────────────────

async function fetchSolanaBalances(
  address: string,
  rpcUrl: string
): Promise<TokenBalance[]> {
  const balances: TokenBalance[] = [];
  try {
    // Native SOL
    const solRes = await fetch(rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] })
    });
    const solData = await solRes.json();
    const lamports: number = solData?.result?.value ?? 0;
    if (lamports > 0) {
      balances.push({ asset: 'SOL', amount: lamports / 1e9, chain: 'solana', walletAddress: address });
    }

    // SPL tokens
    const tokRes = await fetch(rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2,
        method: 'getTokenAccountsByOwner',
        params: [address, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]
      })
    });
    const tokData = await tokRes.json();
    for (const acct of tokData?.result?.value ?? []) {
      const info = acct?.account?.data?.parsed?.info;
      if (!info) continue;
      const uiAmount: number = info.tokenAmount?.uiAmount ?? 0;
      if (uiAmount <= 0) continue;
      const mint: string = info.mint;
      const symbol = resolveSolanaMintSymbol(mint) ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;
      balances.push({ asset: symbol, amount: uiAmount, contractAddress: mint, chain: 'solana', walletAddress: address });
    }
  } catch { /* partial data is fine */ }
  return balances;
}

// ─── Moralis EVM ─────────────────────────────────────────────────────────────

async function fetchMoralisBalances(
  address: string,
  moralisChain: string,
  chainId: string,
  apiKey: string
): Promise<TokenBalance[]> {
  const balances: TokenBalance[] = [];
  const headers = { 'X-API-Key': apiKey, accept: 'application/json' };

  try {
    // Native
    const nRes = await fetch(
      `https://deep-index.moralis.io/api/v2.2/${address}/balance?chain=${moralisChain}`,
      { headers }
    );
    if (nRes.ok) {
      const nd = await nRes.json();
      const amt = Number(BigInt(nd?.balance ?? '0')) / 1e18;
      const sym = MORALIS_CHAIN_NATIVE[moralisChain] ?? 'ETH';
      if (amt > 0) balances.push({ asset: sym, amount: amt, chain: chainId, walletAddress: address });
    }

    // ERC-20
    const tRes = await fetch(
      `https://deep-index.moralis.io/api/v2.2/wallets/${address}/tokens?chain=${moralisChain}`,
      { headers }
    );
    if (tRes.ok) {
      const td = await tRes.json();
      for (const tok of td?.result ?? []) {
        if (tok.possible_spam) continue;
        const amt = parseFloat(tok.balance_formatted ?? '0');
        if (amt <= 0) continue;
        balances.push({
          asset: tok.symbol ?? 'TOKEN', amount: amt,
          contractAddress: tok.token_address, chain: chainId, walletAddress: address
        });
      }
    }
  } catch { /* partial */ }
  return balances;
}

// ─── Public ──────────────────────────────────────────────────────────────────

export async function fetchLiveWalletBalances(
  address: string,
  chainId: string,
  config: WalletBalancesConfig
): Promise<TokenBalance[]> {
  if (chainId === 'solana') {
    if (config.heliusApiKey) {
      return fetchSolanaBalances(address, `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`);
    }
    if (config.alchemyApiKey) {
      return fetchSolanaBalances(address, `https://solana-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`);
    }
    return [];
  }
  const slug = MORALIS_CHAIN_SLUG[chainId];
  if (slug && config.moralisApiKey) {
    return fetchMoralisBalances(address, slug, chainId, config.moralisApiKey);
  }
  return [];
}

/** Aggregate live balances across all saved wallets. */
export async function fetchAllLiveBalances(
  wallets: Array<{ address: string; chain: string }>,
  config: WalletBalancesConfig
): Promise<Map<string, { amount: number; contractAddress?: string; chain: string }>> {
  const result = new Map<string, { amount: number; contractAddress?: string; chain: string }>();
  for (const w of wallets) {
    // eslint-disable-next-line no-await-in-loop
    const bals = await fetchLiveWalletBalances(w.address, w.chain, config);
    for (const b of bals) {
      const key = `${b.chain}:${b.asset.toUpperCase()}:${b.contractAddress ?? ''}`;
      const ex = result.get(key);
      if (ex) {
        ex.amount += b.amount;
      } else {
        result.set(key, { amount: b.amount, contractAddress: b.contractAddress, chain: b.chain });
      }
    }
  }
  return result;
}
