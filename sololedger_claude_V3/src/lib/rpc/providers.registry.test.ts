import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@/types/transaction';
import {
  applyUnifiedIncomingClassifications,
  configureDefiProviderTimeoutsForTests,
  createReceiptActionLoader,
  createReceiptLoader,
  fetchAlchemyEvmInner,
  resetDefiProviderCachesForTests
} from './providers';
import { ERC_TRANSFER_TOPIC } from './evmDecoder';
import { GEOD_REWARDS_WALLET_POLYGON, GEOD_TOKEN_POLYGON } from '@/lib/assets/rewardRegistry';
import { AAVE_DATA_PROVIDER_SELECTORS, PROTOCOL_REGISTRY } from '@/lib/defi/protocolRegistry';

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 'tx', timestamp: 1, type: 'transfer_in', asset: 'GEOD', amount: 1,
    fiatCurrency: 'USD', source: 'rpc:moralis', flags: ['possible_internal_transfer'],
    isInternalTransfer: false, chain: 'polygon', ...overrides
  };
}

const wallet = '0x1111111111111111111111111111111111111111';
const aave = '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9';
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const aUsdc = '0x3333333333333333333333333333333333333333';
const topicAddress = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;
const abiWord = (value: string | bigint | number) => (typeof value === 'string' ? value.replace(/^0x/, '') : BigInt(value).toString(16)).padStart(64, '0');
const reserveList = (symbol: string, reserve: string) => {
  const bytes = [...new TextEncoder().encode(symbol)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `0x${abiWord(32)}${abiWord(1)}${abiWord(32)}${abiWord(64)}${abiWord(reserve)}${abiWord(symbol.length)}${bytes.padEnd(64, '0')}`;
};

describe('provider unified registry fallback', () => {
  beforeEach(() => resetDefiProviderCachesForTests());
  it('preserves high-confidence static behavior without review flag', () => {
    const [result] = applyUnifiedIncomingClassifications([tx({
      contractAddress: GEOD_TOKEN_POLYGON,
      counterpartyAddress: GEOD_REWARDS_WALLET_POLYGON
    })]);
    expect(result.type).toBe('income');
    expect(result.flags).toEqual([]);
  });

  it('keeps non-distribution allocation matches as transfer_in suggestions', () => {
    const [result] = applyUnifiedIncomingClassifications([tx({
      contractAddress: '0x0000000000000000000000000000000000000001',
      counterpartyAddress: '0xfa5fed5cc2b6dd8f370651d17242c52ed711b14f'
    })]);
    expect(result.type).toBe('transfer_in');
    expect(result.flags).toEqual(['needs_review']);
    expect(result.notes).toMatch(/review transfer purpose/i);
  });

  it('loads one receipt at most once for duplicate Alchemy rows sharing a hash', async () => {
    const receipt = { transactionHash: '0xhash', logs: [] };
    const underlying = vi.fn(async () => receipt);
    const load = createReceiptLoader(underlying);
    const [first, second, third] = await Promise.all([
      load('0xHASH'),
      load('0xhash'),
      load('0xHash')
    ]);
    expect(first).toBe(receipt);
    expect(second).toBe(receipt);
    expect(third).toBe(receipt);
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it('analyzes one cached receipt at most once for duplicate represented rows', async () => {
    const receipt = { transactionHash: '0xhash', logs: [] };
    const loadReceipt = vi.fn(async () => receipt);
    const analyze = vi.fn(() => []);
    const loadActions = createReceiptActionLoader(loadReceipt, analyze);
    await Promise.all([loadActions('0xHASH'), loadActions('0xhash'), loadActions('0xHash')]);
    expect(loadReceipt).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('loads the exhaustive registry before first-import history and decodes without current wallet positions', async () => {
    const rawAmount = 1_000_000_000_000_000_001n;
    const shared = {
      hash: '0xshared',
      from: wallet,
      to: aave,
      value: 1,
      asset: 'ETH',
      metadata: { blockTimestamp: '2026-01-01T00:00:00.000Z' }
    };
    const receiptRequests: string[] = [];
    const registryCalls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'eth_blockNumber') {
        registryCalls.push(body.method);
        return new Response(JSON.stringify({ result: '0x1234' }), { status: 200 });
      }
      if (body.method === 'eth_call') {
        const [{ to, data }, block] = body.params;
        registryCalls.push(`${to.toLowerCase()}:${data.slice(0, 10)}:${block}`);
        const protocol = Object.values(PROTOCOL_REGISTRY).find((entry) => entry.dataProviderAddress.toLowerCase() === to.toLowerCase());
        if (!protocol) throw new Error('unexpected registry provider');
        if (data === AAVE_DATA_PROVIDER_SELECTORS.getAllReservesTokens) {
          const reserve = protocol.id === 'aave-v2-ethereum' ? usdc :
            protocol.id === 'aave-v3-ethereum' ? '0x6666666666666666666666666666666666666666' : '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
          return new Response(JSON.stringify({ result: reserveList('USDC', reserve) }), { status: 200 });
        }
        if (data.startsWith(AAVE_DATA_PROVIDER_SELECTORS.getReserveTokensAddresses)) {
          const tokens = protocol.id === 'aave-v2-ethereum'
            ? [aUsdc, '0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555']
            : protocol.id === 'aave-v3-ethereum'
              ? ['0x7777777777777777777777777777777777777777', '0x8888888888888888888888888888888888888888', '0x9999999999999999999999999999999999999999']
              : ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '0xcccccccccccccccccccccccccccccccccccccccc', '0xdddddddddddddddddddddddddddddddddddddddd'];
          return new Response(JSON.stringify({ result: `0x${tokens.map(abiWord).join('')}` }), { status: 200 });
        }
        throw new Error('unexpected registry call');
      }
      if (body.method === 'eth_getTransactionReceipt') {
        receiptRequests.push(body.params[0]);
        return new Response(JSON.stringify({
          result: {
            transactionHash: '0xshared', from: wallet, gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00',
            logs: [
              {
                address: usdc, logIndex: '0x7',
                topics: [ERC_TRANSFER_TOPIC, topicAddress(wallet), topicAddress(aave)],
                data: `0x${rawAmount.toString(16).padStart(64, '0')}`
              },
              {
                address: aUsdc, logIndex: '0x9',
                topics: [ERC_TRANSFER_TOPIC, topicAddress('0x0000000000000000000000000000000000000000'), topicAddress(wallet)],
                data: `0x${(rawAmount - 11n).toString(16).padStart(64, '0')}`
              },
              {
                address: aave, logIndex: '8',
                topics: [
                  '0xde6857219544bb5b7746f48ed30be6386fefc61b2f864cacf559893bf50fd951',
                  topicAddress(usdc), topicAddress(wallet), `0x${'0'.repeat(64)}`
                ],
                data: `${topicAddress(wallet)}${rawAmount.toString(16).padStart(64, '0')}`
              }
            ]
          }
        }), { status: 200 });
      }
      const isOutgoing = Boolean(body.params[0].fromAddress);
      return new Response(JSON.stringify({
        result: {
          transfers: isOutgoing
            ? [
                { ...shared, category: 'external', rawContract: {} },
                { ...shared, category: 'erc20', asset: 'USDC', rawContract: { address: usdc, value: `0x${rawAmount.toString(16)}` } }
              ]
            : []
        }
      }), { status: 200 });
    });

    const result = await fetchAlchemyEvmInner(wallet, 'eth-mainnet', 'key', 'ETH', 'ethereum');
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({ asset: 'ETH', type: 'transfer_out' });
    expect(result.transactions[0].notes).toBeUndefined();
    expect(result.transactions[1]).toMatchObject({ asset: 'USDC', type: 'defi_deposit' });
    expect(result.transactions[1].raw?.defiActionEvidence).toMatchObject({
      type: 'supply', complete: true, evidenceSource: 'ethereum_log', postingAnchor: true,
      eventIds: [
        `event:1:0xshared:${aave}:8`, `event:1:0xshared:${usdc}:7`, `event:1:0xshared:${aUsdc}:9`
      ]
    });
    const evidence = result.transactions[1].raw?.defiActionEvidence as (Record<string, unknown> & { economicLegs?: unknown[] }) | undefined;
    expect(evidence).toMatchObject({ quantity: rawAmount.toString() });
    expect(evidence?.economicLegs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'network_fee', quantity: '21000000000000' })
    ]));
    expect(receiptRequests).toEqual(['0xshared']);
    expect(registryCalls[0]).toBe('eth_blockNumber');
    expect(registryCalls).toHaveLength(7);
    expect(registryCalls.slice(1).every((call) => call.endsWith(':0x1234'))).toBe(true);
  });

  it('reports registry failure and uses bounded failure backoff instead of retrying the crawl', async () => {
    let registryCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'eth_blockNumber') {
        registryCalls++;
        return new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: 503 });
      }
      if (body.method === 'eth_getTransactionReceipt') {
        return new Response(JSON.stringify({ result: null }), { status: 200 });
      }
      if (body.method === 'eth_getTransactionByHash') {
        return new Response(JSON.stringify({ result: { hash: body.params[0], from: wallet, to: aave } }), { status: 200 });
      }
      const incoming = Boolean(body.params[0].toAddress);
      return new Response(JSON.stringify({ result: { transfers: incoming ? [{
        hash: '0xfailure', category: 'erc20', asset: 'USDC', value: 1,
        from: aave, to: wallet, rawContract: { address: usdc, value: '0x1' }
      }] : [] } }), { status: 200 });
    });

    const [first, concurrent] = await Promise.all([
      fetchAlchemyEvmInner(wallet, 'eth-registry-failure', 'key', 'ETH', 'ethereum'),
      fetchAlchemyEvmInner(wallet, 'eth-registry-failure', 'key', 'ETH', 'ethereum')
    ]);
    const backedOff = await fetchAlchemyEvmInner(wallet, 'eth-registry-failure', 'key', 'ETH', 'ethereum');

    expect(registryCalls).toBe(1);
    expect(first.warnings.some((warning) => warning.message.includes('(http)'))).toBe(true);
    expect(concurrent.warnings.some((warning) => warning.message.includes('(http)'))).toBe(true);
    expect(backedOff.warnings.some((warning) => warning.message.includes('(backoff)'))).toBe(true);
  });

  it('caps and caches destination probes without scheduling unrelated receipts or loading the registry', async () => {
    let receiptCalls = 0;
    let registryCalls = 0;
    let destinationCalls = 0;
    const transfers = Array.from({ length: 3_000 }, (_, index) => ({
      hash: `0x${((index % 250) + 1).toString(16)}`, uniqueId: `unrelated-${index}`,
      category: 'erc20', asset: 'TOKEN', value: 1,
      from: wallet, to: `0x${(index + 100).toString(16).padStart(40, '0')}`,
      rawContract: { address: `0x${(index + 10_000).toString(16).padStart(40, '0')}`, value: '0x1' }
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'eth_getTransactionReceipt') receiptCalls++;
      if (body.method === 'eth_getTransactionByHash') destinationCalls++;
      if (body.method === 'eth_blockNumber' || body.method === 'eth_call') registryCalls++;
      if (body.method === 'alchemy_getAssetTransfers') {
        const outgoing = Boolean(body.params[0].fromAddress);
        return new Response(JSON.stringify({ result: { transfers: outgoing ? transfers : [] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    });

    const result = await fetchAlchemyEvmInner(wallet, 'eth-unrelated-stress', 'key', 'ETH', 'ethereum');

    expect(result.transactions).toHaveLength(3_000);
    expect(receiptCalls).toBe(0);
    expect(registryCalls).toBe(0);
    expect(destinationCalls).toBe(200);
    expect(result.transactionDestinationDiagnostics).toMatchObject({
      candidates: 250, checked: 200, matchedPools: 0, notFound: 200,
      skippedBudget: 50, partial: true
    });
  });

  it('bounds concurrent destination probes and reports each timeout explicitly', async () => {
    configureDefiProviderTimeoutsForTests({
      transactionDestinationTimeoutMs: 5,
      transactionDestinationConcurrency: 2,
      transactionDestinationProbeBudget: 10
    });
    let active = 0;
    let maxActive = 0;
    const transfers = Array.from({ length: 5 }, (_, index) => ({
      hash: `0xtimeout${index}`, uniqueId: `timeout-${index}`,
      category: 'erc20', asset: 'TOKEN', value: 1, from: wallet,
      to: `0x${(index + 100).toString(16).padStart(40, '0')}`,
      rawContract: { address: `0x${(index + 200).toString(16).padStart(40, '0')}`, value: '0x1' }
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'eth_getTransactionByHash') {
        active++;
        maxActive = Math.max(maxActive, active);
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            active--;
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      }
      const outgoing = Boolean(body.params[0].fromAddress);
      return new Response(JSON.stringify({ result: { transfers: outgoing ? transfers : [] } }), { status: 200 });
    });

    const result = await fetchAlchemyEvmInner(wallet, 'eth-destination-timeout', 'key', 'ETH', 'ethereum');

    expect(active).toBe(0);
    expect(maxActive).toBe(2);
    expect(result.transactionDestinationDiagnostics).toMatchObject({
      candidates: 5, checked: 5, matchedPools: 0, timedOut: 5, partial: true
    });
    expect(result.warnings.some((warning) =>
      warning.message.includes('destination discovery was partial (5 timed out'))).toBe(true);
  });

  it('aborts a timed-out registry crawl before backoff and never overlaps a retry', async () => {
    configureDefiProviderTimeoutsForTests({ registryTimeoutMs: 5 });
    let registryCalls = 0;
    let activeRegistryCalls = 0;
    let maxActiveRegistryCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'eth_blockNumber') {
        registryCalls++;
        activeRegistryCalls++;
        maxActiveRegistryCalls = Math.max(maxActiveRegistryCalls, activeRegistryCalls);
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            activeRegistryCalls--;
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      }
      if (body.method === 'eth_getTransactionReceipt') {
        return new Response(JSON.stringify({ result: null }), { status: 200 });
      }
      if (body.method === 'eth_getTransactionByHash') {
        return new Response(JSON.stringify({ result: { hash: body.params[0], from: wallet, to: aave } }), { status: 200 });
      }
      const incoming = Boolean(body.params[0].toAddress);
      return new Response(JSON.stringify({ result: { transfers: incoming ? [{
        hash: '0xcandidate', category: 'erc20', asset: 'USDC', value: 1,
        from: aave, to: wallet, rawContract: { address: usdc, value: '0x1' }
      }] : [] } }), { status: 200 });
    });

    const [first, concurrent] = await Promise.all([
      fetchAlchemyEvmInner(wallet, 'eth-registry-timeout', 'key', 'ETH', 'ethereum'),
      fetchAlchemyEvmInner(wallet, 'eth-registry-timeout', 'key', 'ETH', 'ethereum')
    ]);
    expect(activeRegistryCalls).toBe(0);
    const backedOff = await fetchAlchemyEvmInner(wallet, 'eth-registry-timeout', 'key', 'ETH', 'ethereum');

    expect(registryCalls).toBe(1);
    expect(maxActiveRegistryCalls).toBe(1);
    expect(first.warnings.some((warning) => warning.message.includes('(timeout)'))).toBe(true);
    expect(concurrent.warnings.some((warning) => warning.message.includes('(timeout)'))).toBe(true);
    expect(backedOff.warnings.some((warning) => warning.message.includes('(backoff)'))).toBe(true);
  });
});
