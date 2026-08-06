import { describe, expect, it } from 'vitest';
import { decodeEvmReceipt, decodeEvmReceiptForTransfer, decodeNeutralDefiActions, defiEventContractsFromPositions, ERC_TRANSFER_TOPIC, neutralDefiActionForTransfer } from './evmDecoder';
import disputedBorrow from '@/lib/defi/__fixtures__/aave-v3-usdc-borrow-45000.sanitized.json';

const wallet = '0x1111111111111111111111111111111111111111';
const rewards = '0xd784927ff2f95ba542bfc824c8a8a98f3495f6b5';
const rewardVault = '0x25f2226b597e8f9514b3f68f00f494cf4f286491';
const other = '0x2222222222222222222222222222222222222222';
const topicAddress = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;
const data = (amount: bigint) => `0x${amount.toString(16).padStart(64, '0')}`;
const words = (...values: bigint[]) => `0x${values.map((value) => value.toString(16).padStart(64, '0')).join('')}`;
const zero = '0x0000000000000000000000000000000000000000';

describe('EVM receipt decoder', () => {
  it('groups exact multi-event protocol logs by transaction hash and preserves log identities', () => {
    const pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
    const reserve = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const supplyTopic = '0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61';
    const actions = decodeNeutralDefiActions({
      transactionHash: '0xABC',
      logs: [
        { address: pool, logIndex: '0x7', topics: [supplyTopic, topicAddress(reserve), topicAddress(wallet), data(0n)], data: `${topicAddress(wallet)}${data(10n).slice(2)}` },
        { address: reserve, logIndex: '8', topics: [ERC_TRANSFER_TOPIC, topicAddress(wallet), topicAddress(pool)], data: data(10n) },
        { address: pool, logIndex: 9, topics: [supplyTopic, topicAddress(reserve), topicAddress(wallet), data(0n)], data: `${topicAddress(wallet)}${data(5n).slice(2)}` },
        { address: reserve, logIndex: 10, topics: [ERC_TRANSFER_TOPIC, topicAddress(wallet), topicAddress(pool)], data: data(5n) }
      ]
    }, 1, {}, wallet);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      type: 'supply', protocolId: 'aave-v3-ethereum', reserveKey: reserve,
      quantity: '10', complete: false, confidence: 0.5, callId: `event:1:0xabc:${pool}:7`,
      eventIds: [
        `event:1:0xabc:${pool}:7`, `event:1:0xabc:${reserve}:8`
      ]
    });
    expect(actions[1]).toMatchObject({ quantity: '5', complete: false, callId: `event:1:0xabc:${pool}:9` });
  });

  it('retains underlying, protocol-token, debt-token, reward, and fee legs in the receipt graph', () => {
    const pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
    const reserve = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const debtToken = '0x4444444444444444444444444444444444444444';
    const borrow = decodeNeutralDefiActions({
      transactionHash: '0xgraph', from: wallet, to: pool, status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00',
      logs: [
        { address: pool, logIndex: 1, topics: ['0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0', topicAddress(reserve), topicAddress(wallet), data(0n)], data: `${topicAddress(wallet)}${words(40n, 2n, 3n).slice(2)}` },
        { address: reserve, logIndex: 2, topics: [ERC_TRANSFER_TOPIC, topicAddress(pool), topicAddress(wallet)], data: data(40n) },
        { address: debtToken, logIndex: 3, topics: [ERC_TRANSFER_TOPIC, topicAddress(zero), topicAddress(wallet)], data: data(40n) }
      ]
    }, 1, {
      [debtToken]: { protocolId: 'aave-v3-ethereum', reserveKey: reserve, role: 'debt_token' }
    }, wallet)[0];
    expect(borrow.complete).toBe(true);
    expect(borrow.economicLegs?.map((leg) => leg.kind)).toEqual(['underlying', 'debt_token', 'network_fee']);
    expect(borrow.eventIds).not.toContain('fee:1:0xgraph');
  });

  it('fails closed on unsupported chains and incomplete exact events', () => {
    const pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
    const borrowTopic = '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0';
    expect(decodeNeutralDefiActions({ transactionHash: '0xhash', logs: [
      { address: pool, topics: [borrowTopic], data: '0x' }
    ] }, 1, {}, wallet)[0]).toMatchObject({ type: 'borrow', complete: false, confidence: 0.5, eventIds: [] });
    expect(decodeNeutralDefiActions({ transactionHash: '0xhash', logs: [
      { address: pool, topics: [borrowTopic, topicAddress(other)], data: data(1n) }
    ] }, 137)).toEqual([]);
  });

  it('decodes exact interest and reward events only with a supported contract mapping', () => {
    const aToken = '0x2222222222222222222222222222222222222222';
    const reserve = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const interestTopic = '0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196';
    const receipt = { transactionHash: '0xinterest', from: wallet, to: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', status: '0x1', logs: [
      { address: aToken, logIndex: 3, topics: [interestTopic, topicAddress(wallet), topicAddress(wallet)], data: words(100n, 12n, 1n) },
      // ScaledBalanceToken emits Transfer for total minted value; the neutral
      // interest quantity remains Mint.balanceIncrease (12), not value (100).
      { address: aToken, logIndex: 4, topics: [ERC_TRANSFER_TOPIC, topicAddress(zero), topicAddress(wallet)], data: data(100n) }
    ] };
    expect(decodeNeutralDefiActions(receipt)).toEqual([]);
    expect(decodeNeutralDefiActions(receipt, 1, {
      [aToken]: { protocolId: 'aave-v3-ethereum', reserveKey: reserve, role: 'protocol_token' }
    }, wallet)[0]).toMatchObject({ type: 'interest', reserveKey: reserve, quantity: '12', complete: true });
  });

  it('ABI-decodes liquidation debt and collateral quantities separately', () => {
    const pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
    const collateral = '0x2222222222222222222222222222222222222222';
    const debt = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const topic = '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286';
    const action = decodeNeutralDefiActions({ transactionHash: '0xliq', logs: [
      { address: pool, logIndex: 12, topics: [topic, topicAddress(collateral), topicAddress(debt), topicAddress(wallet)], data: words(90n, 75n, 1n, 0n) },
      { address: debt, logIndex: 13, topics: [ERC_TRANSFER_TOPIC, topicAddress(other), topicAddress(pool)], data: data(90n) },
      { address: collateral, logIndex: 14, topics: [ERC_TRANSFER_TOPIC, topicAddress(pool), topicAddress(other)], data: data(75n) }
    ] }, 1, {}, wallet)[0];
    expect(action).toMatchObject({ type: 'liquidation', debtQuantity: '90', collateralQuantity: '75', complete: true });
  });

  it('uses action/version-specific Borrow, Withdraw, Repay, and RewardsClaimed layouts', () => {
    const pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
    const reserve = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const controller = '0x3333333333333333333333333333333333333333';
    const reward = '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9';
    const aToken = '0x5555555555555555555555555555555555555555';
    const debtToken = '0x6666666666666666666666666666666666666666';
    const receipt = { transactionHash: '0xlayouts', from: wallet, to: pool, status: '0x1', logs: [
      { address: pool, logIndex: 1, topics: ['0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0', topicAddress(reserve), topicAddress(wallet), data(0n)], data: `${topicAddress(wallet)}${words(40n, 2n, 3n).slice(2)}` },
      { address: reserve, logIndex: 2, topics: [ERC_TRANSFER_TOPIC, topicAddress(pool), topicAddress(wallet)], data: data(40n) },
      { address: debtToken, logIndex: '0x2a', topics: [ERC_TRANSFER_TOPIC, topicAddress(zero), topicAddress(wallet)], data: data(37n) },
      { address: pool, logIndex: 3, topics: ['0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7', topicAddress(reserve), topicAddress(wallet), topicAddress(wallet)], data: data(30n) },
      { address: reserve, logIndex: 4, topics: [ERC_TRANSFER_TOPIC, topicAddress(pool), topicAddress(wallet)], data: data(30n) },
      { address: aToken, logIndex: '0x4a', topics: [ERC_TRANSFER_TOPIC, topicAddress(wallet), topicAddress(zero)], data: data(29n) },
      { address: pool, logIndex: 5, topics: ['0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051', topicAddress(reserve), topicAddress(wallet), topicAddress(wallet)], data: words(20n, 0n) },
      { address: reserve, logIndex: 6, topics: [ERC_TRANSFER_TOPIC, topicAddress(wallet), topicAddress(pool)], data: data(20n) },
      { address: debtToken, logIndex: '0x6a', topics: [ERC_TRANSFER_TOPIC, topicAddress(wallet), topicAddress(zero)], data: data(19n) },
      { address: controller, logIndex: 7, topics: ['0xc052130bc4ef84580db505783484b067ea8b71b3bca78a7e12db7aea8658f004', topicAddress(wallet), topicAddress(reward), topicAddress(wallet)], data: `${topicAddress(wallet)}${data(9n).slice(2)}` },
      { address: reward, logIndex: 8, topics: [ERC_TRANSFER_TOPIC, topicAddress(controller), topicAddress(wallet)], data: data(9n) }
    ] };
    const actions = decodeNeutralDefiActions(receipt, 1, {
      [controller]: { protocolId: 'aave-v3-ethereum', reserveKey: reward, role: 'reward_controller' },
      [reward]: { protocolId: 'aave-v3-ethereum', reserveKey: reward, role: 'reward' },
      [aToken]: { protocolId: 'aave-v3-ethereum', reserveKey: reserve, role: 'protocol_token' },
      [debtToken]: { protocolId: 'aave-v3-ethereum', reserveKey: reserve, role: 'debt_token' }
    }, wallet);
    expect(actions.map((action) => [action.type, action.quantity, action.complete])).toEqual([
      ['borrow', '40', true], ['withdraw', '30', true], ['repay', '20', true], ['reward', '9', true]
    ]);
  });

  it('decodes the real Aave v2 three-topic RewardsClaimed layout and exact AAVE transfer', () => {
    const aave = '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9';
    const amount = 9_000_000_000_000_000_001n;
    const action = decodeNeutralDefiActions({ transactionHash: '0xv2reward', logs: [
      {
        address: rewards, logIndex: 21,
        topics: [
          '0x9310ccfcb8de723f578a9e4282ea9f521f05ae40dc08f3068dfad528a65ee3c7',
          topicAddress(wallet), topicAddress(wallet)
        ],
        data: data(amount)
      },
      {
        address: aave, logIndex: 22,
        topics: [ERC_TRANSFER_TOPIC, topicAddress(rewardVault), topicAddress(wallet)],
        data: data(amount)
      }
    ] }, 1, {}, wallet)[0];
    expect(action).toMatchObject({
      type: 'reward', protocolId: 'aave-v2-ethereum', reserveKey: aave,
      quantity: amount.toString(), complete: true
    });
    expect(action.economicLegs).toEqual([
      expect.objectContaining({ kind: 'reward', contractAddress: aave, from: rewardVault, to: wallet, quantity: amount.toString() })
    ]);

    const wrongTransfer = decodeNeutralDefiActions({ transactionHash: '0xv2wrong', logs: [
      {
        address: rewards, logIndex: 1,
        topics: ['0x9310ccfcb8de723f578a9e4282ea9f521f05ae40dc08f3068dfad528a65ee3c7', topicAddress(wallet), topicAddress(wallet)],
        data: data(amount)
      },
      { address: aave, logIndex: 2, topics: [ERC_TRANSFER_TOPIC, topicAddress(other), topicAddress(wallet)], data: data(amount) }
    ] }, 1, {}, wallet)[0];
    expect(wrongTransfer).toMatchObject({ type: 'reward', complete: false });
  });

  it('keeps 18-decimal base units exact and requires mapped protocol-token semantics', () => {
    const pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
    const reserve = '0x6b175474e89094c44da98b954eedeac495271d0f';
    const aToken = '0x7777777777777777777777777777777777777777';
    const amount = 1_000_000_000_000_000_001n;
    const receipt = { transactionHash: '0xlarge', from: wallet, gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: [
      { address: pool, logIndex: 1, topics: ['0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61', topicAddress(reserve), topicAddress(wallet), data(0n)], data: `${topicAddress(wallet)}${data(amount).slice(2)}` },
      { address: reserve, logIndex: 2, topics: [ERC_TRANSFER_TOPIC, topicAddress(wallet), topicAddress(pool)], data: data(amount) },
      // The aToken balance delta is intentionally not equal to the underlying
      // base units; the validated token role/direction is the semantic proof.
      { address: aToken, logIndex: 3, topics: [ERC_TRANSFER_TOPIC, topicAddress(zero), topicAddress(wallet)], data: data(amount - 7n) }
    ] };
    const unmapped = decodeNeutralDefiActions(receipt, 1, {}, wallet)[0];
    expect(unmapped).toMatchObject({ quantity: amount.toString(), complete: false });
    const mapped = decodeNeutralDefiActions(receipt, 1, {
      [aToken]: { protocolId: 'aave-v3-ethereum', reserveKey: reserve, role: 'protocol_token' }
    }, wallet)[0];
    expect(mapped).toMatchObject({ quantity: amount.toString(), complete: true });
    expect(mapped.economicLegs?.map((leg) => leg.quantity)).toContain(amount.toString());
    expect(neutralDefiActionForTransfer([mapped], {
      contractAddress: reserve, direction: 'transfer_out', from: wallet, to: pool,
      rawQuantity: amount.toString()
    })).toBe(mapped);
  });

  it('builds protocol-token mappings only from registry-backed A3 position evidence', () => {
    const reserve = '0x6b175474e89094c44da98b954eedeac495271d0f';
    const aToken = '0x7777777777777777777777777777777777777777';
    const row = {
      protocolId: 'aave-v3-ethereum', reserveKey: reserve, role: 'supply' as const,
      underlying: { contractAddress: reserve }, protocolToken: { contractAddress: aToken }
    };
    expect(defiEventContractsFromPositions(1, [row])).toMatchObject({
      [reserve]: { protocolId: 'aave-v3-ethereum', reserveKey: reserve },
      [aToken]: { protocolId: 'aave-v3-ethereum', reserveKey: reserve, role: 'protocol_token' }
    });
    expect(defiEventContractsFromPositions(137, [row])).toEqual({});
    expect(defiEventContractsFromPositions(1, [{ ...row, underlying: { contractAddress: other } }])).toEqual({});
  });

  it('requires canonical log indexes and refuses ambiguous represented legs', () => {
    const pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
    const reserve = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const supplyTopic = '0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61';
    const action = decodeNeutralDefiActions({ transactionHash: '0xambiguous', logs: [
      { address: pool, logIndex: 'not-an-index', topics: [supplyTopic, topicAddress(reserve), topicAddress(wallet), data(0n)], data: `${topicAddress(wallet)}${data(10n).slice(2)}` },
      { address: reserve, logIndex: 2, topics: [ERC_TRANSFER_TOPIC, topicAddress(wallet), topicAddress(pool)], data: data(10n) },
      { address: reserve, logIndex: 3, topics: [ERC_TRANSFER_TOPIC, topicAddress(wallet), topicAddress(pool)], data: data(10n) }
    ] }, 1, {}, wallet)[0];
    expect(action).toMatchObject({ complete: false, eventIds: [
      `event:1:0xambiguous:${reserve}:2`, `event:1:0xambiguous:${reserve}:3`
    ] });
    expect(neutralDefiActionForTransfer([action], {
      contractAddress: reserve, direction: 'transfer_out', from: wallet, to: pool, rawQuantity: '10'
    })).toBeUndefined();
  });

  it('proves the disputed 45,000 USDC Aave v3 borrow and rejects spoofed/delegated variants', () => {
    const receipt = { ...disputedBorrow.receipt, evidenceProvider: 'blockscout' as const };
    const contracts = disputedBorrow.eventContracts as Parameters<typeof decodeNeutralDefiActions>[2];
    const actions = decodeNeutralDefiActions(receipt, 1, contracts, disputedBorrow.wallet);
    const borrow = actions.find((action) => action.type === 'borrow');
    expect(borrow).toMatchObject({
      type: 'borrow', quantity: '45000000000', reserveKey: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      protocolId: 'aave-v3-ethereum', complete: true, confidence: 1,
      ruleId: 'defi-receipt:aave-v3-ethereum:borrow', ruleVersion: 'b5.1',
      callEvidence: { provider: 'blockscout', from: disputedBorrow.wallet, status: 'success' }
    });
    expect(actions.find((action) => action.type === 'interest')).toMatchObject({
      quantity: '0', interestKind: 'borrowing', complete: false
    });

    expect(decodeNeutralDefiActions({ ...receipt, from: other }, 1, contracts, disputedBorrow.wallet)
      .find((action) => action.type === 'borrow')).toMatchObject({ complete: false });
    const delegated = structuredClone(receipt);
    delegated.logs[4].data = `${topicAddress(other)}${delegated.logs[4].data.slice(66)}`;
    expect(decodeNeutralDefiActions(delegated, 1, contracts, disputedBorrow.wallet)
      .find((action) => action.type === 'borrow')).toMatchObject({ complete: false });
  });

  it('decodes verified ERC-20 Transfer topics with known decimals', () => {
    const result = decodeEvmReceipt({
      transactionHash: '0xhash',
      logs: [{
        address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        topics: [ERC_TRANSFER_TOPIC, topicAddress(rewards), topicAddress(wallet)],
        data: data(1_500_000n)
      }]
    }, wallet);
    expect(result).toMatchObject({ type: 'income', asset: 'USDC', amount: 1.5, rawAmount: '1500000' });
  });

  it('correlates a specific Alchemy row in a multi-log receipt', () => {
    const receipt = {
      transactionHash: '0xhash',
      logs: [
        {
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          topics: [ERC_TRANSFER_TOPIC, topicAddress(rewards), topicAddress(wallet)],
          data: data(2_000_000n)
        },
        {
          address: '0x6b175474e89094c44da98b954eedeac495271d0f',
          topics: [ERC_TRANSFER_TOPIC, topicAddress(other), topicAddress(wallet)],
          data: data(3_000_000_000_000_000_000n)
        }
      ]
    };

    const dai = decodeEvmReceiptForTransfer(receipt, wallet, {
      contractAddress: '0x6b175474e89094c44da98b954eedeac495271d0f',
      direction: 'transfer_in',
      from: other,
      to: wallet
    });
    expect(dai).toMatchObject({ type: 'transfer_in', asset: 'DAI', counterpartyAddress: other });
    expect(dai?.notes).toBeUndefined();
    expect(decodeEvmReceiptForTransfer(receipt, wallet, {
      contractAddress: '0x6b175474e89094c44da98b954eedeac495271d0f',
      direction: 'transfer_in',
      from: rewards,
      to: wallet
    })).toBeNull();
  });

  it('preserves raw amount instead of assuming 18 decimals for unknown tokens', () => {
    const result = decodeEvmReceipt({
      transactionHash: '0xhash',
      logs: [{
        address: '0x9999999999999999999999999999999999999999',
        topics: [ERC_TRANSFER_TOPIC, topicAddress(rewards), topicAddress(wallet)],
        data: data(123n)
      }]
    }, wallet);
    expect(result?.amount).toBeUndefined();
    expect(result?.rawAmount).toBe('123');
  });

  it('does not misread ERC-721 Transfer logs as ERC-20', () => {
    expect(decodeEvmReceipt({
      transactionHash: '0xhash',
      logs: [{
        address: '0x9999999999999999999999999999999999999999',
        topics: [ERC_TRANSFER_TOPIC, topicAddress(rewards), topicAddress(wallet), `0x${'0'.repeat(63)}1`],
        data: '0x'
      }]
    }, wallet)).toBeNull();
  });

  it('ignores malformed logs and classifies outgoing router legs without contaminating direction', () => {
    const router = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
    const receipt = {
      transactionHash: '0xhash',
      logs: [
        { address: '0x9999999999999999999999999999999999999999', topics: [ERC_TRANSFER_TOPIC, '0xbad', topicAddress(wallet)], data: '0xzz' },
        { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', topics: [ERC_TRANSFER_TOPIC, topicAddress(wallet), topicAddress(router)], data: data(2_000_000n) }
      ]
    };
    expect(decodeEvmReceiptForTransfer(receipt, wallet, {
      contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', direction: 'transfer_out', from: wallet, to: router
    })).toMatchObject({ type: 'trade', amount: 2, counterpartyAddress: router, rawAmount: '2000000' });
    expect(decodeEvmReceiptForTransfer(receipt, wallet, {
      contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', direction: 'transfer_in', from: router, to: wallet
    })).toBeNull();
  });
});
