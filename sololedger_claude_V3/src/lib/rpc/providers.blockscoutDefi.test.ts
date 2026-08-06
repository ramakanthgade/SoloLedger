import { afterEach, describe, expect, it, vi } from 'vitest';
import disputedBorrow from '@/lib/defi/__fixtures__/aave-v3-usdc-borrow-45000.sanitized.json';
import { AAVE_DATA_PROVIDER_SELECTORS, PROTOCOL_REGISTRY } from '@/lib/defi/protocolRegistry';
import { fetchAlchemyEvmInner, fetchBlockscoutEthereum, resetDefiProviderCachesForTests } from './providers';

const wallet = disputedBorrow.wallet;
const hash = disputedBorrow.receipt.transactionHash;
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const aUsdc = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c';

const party = (address: string) => ({ hash: address });
const abiWord = (value: string | bigint | number) => (typeof value === 'string'
  ? value.replace(/^0x/, '')
  : BigInt(value).toString(16)).padStart(64, '0');
const reserveList = (symbol: string, reserve: string) => {
  const bytes = [...new TextEncoder().encode(symbol)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `0x${abiWord(32)}${abiWord(1)}${abiWord(32)}${abiWord(64)}${abiWord(reserve)}${abiWord(symbol.length)}${bytes.padEnd(64, '0')}`;
};
const tokenRow = {
  transaction_hash: hash, log_index: 89, timestamp: '2026-08-05T12:00:00.000Z',
  from: party(aUsdc), to: party(wallet),
  token: { address_hash: usdc, symbol: 'USDC', decimals: '6' },
  total: { value: '45000000000' }
};

describe('Blockscout receipt-proof DeFi enrichment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetDefiProviderCachesForTests();
  });

  it('promotes the exact disputed principal row, removes the transfer guess, and caches its receipt', async () => {
    let receiptCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST') {
        receiptCalls++;
        return new Response(JSON.stringify({ result: disputedBorrow.receipt }), { status: 200 });
      }
      if (url.includes('/token-transfers')) {
        return new Response(JSON.stringify({ items: [tokenRow], next_page_params: null }), { status: 200 });
      }
      if (url.includes('/transactions')) {
        return new Response(JSON.stringify({ items: [{
          hash, status: 'ok', value: '0', timestamp: tokenRow.timestamp,
          from: party(wallet), to: party(disputedBorrow.receipt.to)
        }], next_page_params: null }), { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await fetchBlockscoutEthereum(
      wallet,
      disputedBorrow.eventContracts as Parameters<typeof fetchBlockscoutEthereum>[1]
    );
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      txHash: hash, type: 'transfer_in', category: 'loan', categoryOrigin: 'rule',
      categoryRuleId: 'defi-receipt:aave-v3-ethereum:borrow', flags: []
    });
    expect(result.transactions[0].flags).not.toContain('possible_internal_transfer');
    expect(result.transactions[0].raw?.defiActionEvidence).toMatchObject({
      type: 'borrow', complete: true, quantity: '45000000000', postingAnchor: true,
      callEvidence: { provider: 'blockscout', status: 'success' }
    });
    expect(receiptCalls).toBe(1);
  });

  it('does not promote an address-lookalike transfer without the exact receipt action', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST') return new Response(JSON.stringify({ result: {
        ...disputedBorrow.receipt, logs: disputedBorrow.receipt.logs.filter((log) =>
          log.topics[0] !== '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0')
      } }), { status: 200 });
      if (url.includes('/token-transfers')) return new Response(JSON.stringify({ items: [tokenRow] }), { status: 200 });
      return new Response(JSON.stringify({ items: [{
        hash, status: 'ok', value: '0', from: party(wallet), to: party(disputedBorrow.receipt.to)
      }] }), { status: 200 });
    });
    const [row] = (await fetchBlockscoutEthereum(wallet, disputedBorrow.eventContracts as Parameters<typeof fetchBlockscoutEthereum>[1])).transactions;
    expect(row.type).toBe('transfer_in');
    expect(row.category).toBeUndefined();
    expect(row.flags).toContain('possible_internal_transfer');
    expect(row.raw?.defiActionEvidence).toBeUndefined();
  });
});

describe('provider-consistent exact semantics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetDefiProviderCachesForTests();
  });

  it('produces the same loan semantics when Alchemy supplies the represented transfer', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === 'eth_getTransactionReceipt') {
        return new Response(JSON.stringify({ result: disputedBorrow.receipt }), { status: 200 });
      }
      if (request.method === 'eth_getTransactionByHash') {
        return new Response(JSON.stringify({ result: {
          hash, from: wallet, to: disputedBorrow.receipt.to
        } }), { status: 200 });
      }
      const incoming = Boolean(request.params[0].toAddress);
      return new Response(JSON.stringify({ result: { transfers: incoming ? [{
        hash, category: 'erc20', asset: 'USDC', value: 45_000,
        from: aUsdc, to: wallet, metadata: { blockTimestamp: tokenRow.timestamp },
        rawContract: { address: usdc, value: '0xa7a358200' }
      }] : [] } }), { status: 200 });
    });
    const result = await fetchAlchemyEvmInner(
      wallet, 'eth-mainnet', 'key', 'ETH', 'ethereum',
      disputedBorrow.eventContracts as Parameters<typeof fetchAlchemyEvmInner>[5]
    );
    expect(result.transactions[0]).toMatchObject({
      type: 'transfer_in', category: 'loan', categoryOrigin: 'rule', flags: [],
      raw: { defiActionEvidence: {
        type: 'borrow', quantity: '45000000000', postingAnchor: true,
        callEvidence: { provider: 'alchemy', status: 'success' }
      } }
    });
  });

  it('discovers the disputed Pool call and exact loan without supplied event contracts', async () => {
    let destinationCalls = 0;
    let receiptCalls = 0;
    let registrySeed = 100;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === 'eth_getTransactionByHash') {
        destinationCalls++;
        return new Response(JSON.stringify({ result: { hash, from: wallet, to: disputedBorrow.receipt.to } }), { status: 200 });
      }
      if (request.method === 'eth_getTransactionReceipt') {
        receiptCalls++;
        return new Response(JSON.stringify({ result: disputedBorrow.receipt }), { status: 200 });
      }
      if (request.method === 'eth_blockNumber') {
        return new Response(JSON.stringify({ result: '0x1234' }), { status: 200 });
      }
      if (request.method === 'eth_call') {
        const [{ to, data }] = request.params;
        const protocol = Object.values(PROTOCOL_REGISTRY).find((entry) =>
          entry.dataProviderAddress.toLowerCase() === String(to).toLowerCase());
        if (!protocol) throw new Error('unexpected registry provider');
        const isAaveV3 = protocol.id === 'aave-v3-ethereum';
        const reserve = isAaveV3
          ? usdc
          : `0x${(++registrySeed).toString(16).padStart(40, '0')}`;
        if (data === AAVE_DATA_PROVIDER_SELECTORS.getAllReservesTokens) {
          return new Response(JSON.stringify({ result: reserveList('USDC', reserve) }), { status: 200 });
        }
        if (data.startsWith(AAVE_DATA_PROVIDER_SELECTORS.getReserveTokensAddresses)) {
          const tokens = isAaveV3
            ? [aUsdc, `0x${'7'.repeat(40)}`, '0x72e95b8931767c79ba4eee721354d6e99a61d004']
            : [1, 2, 3].map(() => `0x${(++registrySeed).toString(16).padStart(40, '0')}`);
          return new Response(JSON.stringify({ result: `0x${tokens.map(abiWord).join('')}` }), { status: 200 });
        }
      }
      const incoming = Boolean(request.params[0].toAddress);
      return new Response(JSON.stringify({ result: { transfers: incoming ? [{
        hash, category: 'erc20', asset: 'USDC', value: 45_000,
        from: aUsdc, to: wallet, metadata: { blockTimestamp: tokenRow.timestamp },
        rawContract: { address: usdc, value: '0xa7a358200', decimal: '6' }
      }] : [] } }), { status: 200 });
    });

    const result = await fetchAlchemyEvmInner(wallet, 'eth-no-supplied-registry', 'key', 'ETH', 'ethereum');

    expect(destinationCalls).toBe(1);
    expect(receiptCalls).toBe(1);
    expect(result.transactionDestinationDiagnostics).toMatchObject({
      candidates: 1, checked: 1, matchedPools: 1, partial: false
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      type: 'transfer_in', category: 'loan', categoryOrigin: 'rule', amount: 45_000, flags: [],
      raw: { defiActionEvidence: {
        type: 'borrow', quantity: '45000000000', postingAnchor: true,
        callEvidence: { provider: 'alchemy', status: 'success' }
      } }
    });
  });

  it('persists destination progress and upgrades a valid borrow beyond the first 200 hashes', async () => {
    const unrelated = Array.from({ length: 200 }, (_, index) => ({
      hash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
      uniqueId: `before-cutoff-${index}`,
      category: 'erc20', asset: 'TOKEN', value: 1,
      from: `0x${(index + 1).toString(16).padStart(40, '0')}`, to: wallet,
      metadata: { blockTimestamp: tokenRow.timestamp },
      rawContract: {
        address: `0x${(index + 1_000).toString(16).padStart(40, '0')}`,
        value: '0x1', decimal: '0'
      }
    }));
    const borrow = {
      hash, uniqueId: 'valid-borrow-after-cutoff', category: 'erc20', asset: 'USDC', value: 45_000,
      from: aUsdc, to: wallet, metadata: { blockTimestamp: tokenRow.timestamp },
      rawContract: { address: usdc, value: '0xa7a358200', decimal: '6' }
    };
    let destinationCalls = 0;
    let receiptCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === 'eth_getTransactionByHash') {
        destinationCalls++;
        const requestedHash = String(request.params[0]).toLowerCase();
        return new Response(JSON.stringify({ result: {
          hash: requestedHash,
          from: wallet,
          to: requestedHash === hash.toLowerCase()
            ? disputedBorrow.receipt.to
            : `0x${'f'.repeat(40)}`
        } }), { status: 200 });
      }
      if (request.method === 'eth_getTransactionReceipt') {
        receiptCalls++;
        return new Response(JSON.stringify({ result: disputedBorrow.receipt }), { status: 200 });
      }
      const incoming = Boolean(request.params[0].toAddress);
      return new Response(JSON.stringify({
        result: { transfers: incoming ? [...unrelated, borrow] : [] }
      }), { status: 200 });
    });

    const first = await fetchAlchemyEvmInner(
      wallet, 'eth-progress-after-cutoff', 'key', 'ETH', 'ethereum',
      disputedBorrow.eventContracts as Parameters<typeof fetchAlchemyEvmInner>[5]
    );

    expect(destinationCalls).toBe(200);
    expect(receiptCalls).toBe(0);
    expect(first.transactionDestinationDiagnostics).toMatchObject({
      candidates: 201, checked: 200, matchedPools: 0, remaining: 1, skippedBudget: 1, partial: true
    });
    expect(first.transactions.find((row) => row.txHash === hash)).toMatchObject({
      type: 'transfer_in', category: undefined
    });

    // Simulate an application/module restart: volatile caches are gone while
    // wallet/source-scoped browser progress remains durable.
    resetDefiProviderCachesForTests({ preserveDestinationProgress: true });
    const second = await fetchAlchemyEvmInner(
      wallet, 'eth-progress-after-cutoff', 'key', 'ETH', 'ethereum',
      disputedBorrow.eventContracts as Parameters<typeof fetchAlchemyEvmInner>[5]
    );

    expect(destinationCalls).toBe(201);
    expect(receiptCalls).toBe(1);
    expect(second.transactionDestinationDiagnostics).toMatchObject({
      candidates: 201, checked: 1, matchedPools: 1, remaining: 0, skippedBudget: 0, partial: false
    });
    expect(second.transactions.find((row) => row.txHash === hash)).toMatchObject({
      type: 'transfer_in', category: 'loan', categoryOrigin: 'rule', amount: 45_000, flags: [],
      raw: { defiActionEvidence: { type: 'borrow', quantity: '45000000000', postingAnchor: true } }
    });

    resetDefiProviderCachesForTests({ preserveDestinationProgress: true });
    const third = await fetchAlchemyEvmInner(
      wallet, 'eth-progress-after-cutoff', 'key', 'ETH', 'ethereum',
      disputedBorrow.eventContracts as Parameters<typeof fetchAlchemyEvmInner>[5]
    );
    expect(destinationCalls).toBe(201);
    expect(receiptCalls).toBe(2);
    expect(third.transactionDestinationDiagnostics).toMatchObject({
      candidates: 201, checked: 0, matchedPools: 1, remaining: 0, partial: false
    });
  });

  it('binds and suppresses an Alchemy debt-token mint while synthesizing unequal borrowing interest', async () => {
    const debtToken = '0x72e95b8931767c79ba4eee721354d6e99a61d004';
    const pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
    const zero = `0x${'0'.repeat(40)}`;
    const interestHash = '0xabc123';
    const topicAddress = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;
    const word = (value: bigint) => value.toString(16).padStart(64, '0');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === 'eth_getTransactionReceipt') return new Response(JSON.stringify({ result: {
        transactionHash: interestHash, from: wallet, to: pool, status: '0x1', logs: [
          {
            address: debtToken, logIndex: 3,
            topics: ['0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196', topicAddress(wallet), topicAddress(wallet)],
            data: `0x${word(100n)}${word(12n)}${word(1n)}`
          },
          {
            address: debtToken, logIndex: 4,
            topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topicAddress(zero), topicAddress(wallet)],
            data: `0x${word(100n)}`
          }
        ]
      } }), { status: 200 });
      if (request.method === 'eth_getTransactionByHash') return new Response(JSON.stringify({ result: {
        hash: interestHash, from: wallet, to: pool
      } }), { status: 200 });
      const incoming = Boolean(request.params[0].toAddress);
      return new Response(JSON.stringify({ result: { transfers: incoming ? [{
        hash: interestHash, category: 'erc20', asset: 'variableDebtUSDC', value: 0.0001,
        from: zero, to: wallet, metadata: { blockTimestamp: tokenRow.timestamp },
        rawContract: { address: debtToken, value: '0x64' }
      }] : [] } }), { status: 200 });
    });

    const result = await fetchAlchemyEvmInner(wallet, 'eth-interest', 'key', 'ETH', 'ethereum', {
      [debtToken]: { protocolId: 'aave-v3-ethereum', reserveKey: usdc, role: 'debt_token' }
    });

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      type: 'fee', category: 'loan_fee', asset: 'USDC', amount: 0.000012,
      contractAddress: usdc,
      raw: { syntheticDefiComponent: true, defiActionEvidence: {
        quantity: '12', postingAnchorRawQuantity: '12', postingAnchorEventId: `event:1:${interestHash}:${debtToken}:4`
      } }
    });
  });
});
