import { describe, expect, it } from 'vitest';
import type { AccountIdentityRow } from '@/lib/accounts/accountIdentity';
import type { CsvImportRow, ExchangeConnectionRow, LookupAddressRow } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import {
  buildSourcePresentationIndexes,
  buildTransactionSourcePresentations,
  sourcePresentationForTransaction
} from './sourcePresentation';

const EVM = '0xA000000000000000000000000000000000000001';

function account(over: Partial<AccountIdentityRow> & Pick<AccountIdentityRow, 'id' | 'kind'>): AccountIdentityRow {
  return {
    canonicalKey: over.id,
    ownershipStatus: 'unknown', ownershipOrigin: 'migration',
    createdAt: 1, updatedAt: 1, lifecycleRevision: 0,
    ...over
  };
}

function tx(over: Partial<Transaction> & Pick<Transaction, 'id'>): Transaction {
  return {
    timestamp: 1, type: 'buy', asset: 'ETH', amount: 1, fiatCurrency: 'USD',
    source: 'unknown', flags: [], isInternalTransfer: false, ...over
  };
}

function wallet(over: Partial<LookupAddressRow> & Pick<LookupAddressRow, 'id' | 'chain' | 'address'>): LookupAddressRow {
  return { lastSyncedAt: 1, txCount: 1, ...over };
}

function exchange(over: Partial<ExchangeConnectionRow> & Pick<ExchangeConnectionRow, 'id' | 'exchange'>): ExchangeConnectionRow {
  return { createdAt: 1, cursors: {}, status: 'ok', ...over };
}

function csv(over: Partial<CsvImportRow> & Pick<CsvImportRow, 'id' | 'fileName'>): CsvImportRow {
  return { importedAt: 1, txCount: 1, parserId: null, ...over };
}

describe('B2 exact source presentation', () => {
  it('uses the exact MetaMask source row while sharing one EVM account across chains', () => {
    const accountRow = account({ id: `wallet:evm:${EVM.toLowerCase()}`, kind: 'wallet', label: 'Main wallet', walletAppId: 'metamask' });
    const rows = [
      wallet({ id: `ethereum:${EVM}`, chain: 'ethereum', address: EVM, walletAppId: 'metamask', accountIdentityId: accountRow.id }),
      wallet({ id: `polygon:${EVM}`, chain: 'polygon', address: EVM, walletAppId: 'metamask', accountIdentityId: accountRow.id })
    ];
    const indexes = buildSourcePresentationIndexes({ accounts: [accountRow], wallets: rows, exchanges: [], csvImports: [] });
    const eth = sourcePresentationForTransaction(tx({ id: 'eth', source: 'rpc:alchemy', chain: 'ethereum', walletAddress: EVM }), indexes, 'Ethereum');
    const polygon = sourcePresentationForTransaction(tx({ id: 'polygon', source: 'rpc:alchemy', chain: 'polygon', walletAddress: EVM }), indexes, 'Polygon');

    expect(eth).toMatchObject({ accountKey: accountRow.id, primaryLabel: 'Main wallet', iconId: 'metamask', status: 'resolved' });
    expect(eth.filterLabel).toBe('Main wallet · Ethereum · 0xA000…0001');
    expect(polygon.filterLabel).toBe('Main wallet · Polygon · 0xA000…0001');
    expect(eth.sourceKey).not.toBe(polygon.sourceKey);
  });

  it('keeps duplicate wallet labels and addresses collision-free', () => {
    const second = '0xB000000000000000000000000000000000000002';
    const a = account({ id: `wallet:evm:${EVM.toLowerCase()}`, kind: 'wallet', label: 'Trading' });
    const b = account({ id: `wallet:evm:${second.toLowerCase()}`, kind: 'wallet', label: 'Trading' });
    const wallets = [
      wallet({ id: `ethereum:${EVM}`, chain: 'ethereum', address: EVM, label: 'Trading', accountIdentityId: a.id }),
      wallet({ id: `ethereum:${second}`, chain: 'ethereum', address: second, label: 'Trading', accountIdentityId: b.id })
    ];
    const transactions = [
      tx({ id: 'a', source: 'rpc:alchemy', chain: 'ethereum', walletAddress: EVM }),
      tx({ id: 'b', source: 'rpc:alchemy', chain: 'ethereum', walletAddress: second })
    ];
    const presentations = buildTransactionSourcePresentations(transactions, buildSourcePresentationIndexes({ accounts: [a, b], wallets, exchanges: [], csvImports: [] }));
    expect(presentations.get('a')?.filterLabel).not.toBe(presentations.get('b')?.filterLabel);
    expect(presentations.get('a')?.sourceKey).not.toBe(presentations.get('b')?.sourceKey);
  });

  it('never guesses between two same-brand exchange accounts', () => {
    const firstAccount = account({ id: 'exchange:exc-first', kind: 'exchange', label: 'Trading' });
    const secondAccount = account({ id: 'exchange:exc-second', kind: 'exchange', label: 'Trading' });
    const indexes = buildSourcePresentationIndexes({
      accounts: [firstAccount, secondAccount], wallets: [], csvImports: [],
      exchanges: [
        exchange({ id: 'exc-first', exchange: 'binance', label: 'Trading', accountIdentityId: firstAccount.id }),
        exchange({ id: 'exc-second', exchange: 'binance', label: 'Trading', accountIdentityId: secondAccount.id })
      ]
    });
    const first = sourcePresentationForTransaction(tx({ id: 'one', source: 'binance_api', importBatchId: 'exc-first' }), indexes);
    const second = sourcePresentationForTransaction(tx({ id: 'two', source: 'binance_api', importBatchId: 'exc-second' }), indexes);
    expect(first.filterLabel).toBe('Trading · Binance · exc-first');
    expect(second.filterLabel).toBe('Trading · Binance · exc-second');
    expect(first.accountKey).toBe(firstAccount.id);
    expect(second.accountKey).toBe(secondAccount.id);
  });

  it('reuses a durable recurring CSV account without merging file generations', () => {
    const csvAccount = account({ id: 'csv-account:recurring-binance', kind: 'csv', label: 'Binance archive', parserId: 'binance' });
    const indexes = buildSourcePresentationIndexes({
      accounts: [csvAccount], wallets: [], exchanges: [],
      csvImports: [
        csv({ id: 'file-generation-one', fileName: 'history.csv', parserId: 'binance', accountIdentityId: csvAccount.id }),
        csv({ id: 'file-generation-two', fileName: 'history.csv', parserId: 'binance', accountIdentityId: csvAccount.id })
      ]
    });
    const one = sourcePresentationForTransaction(tx({ id: 'one', source: 'binance', importBatchId: 'file-generation-one' }), indexes);
    const two = sourcePresentationForTransaction(tx({ id: 'two', source: 'binance', importBatchId: 'file-generation-two' }), indexes);
    expect(one.accountKey).toBe(two.accountKey);
    expect(one.sourceKey).not.toBe(two.sourceKey);
    expect(one.filterLabel).not.toBe(two.filterLabel);
    expect(one.iconId).toBe('binance');
  });

  it('prefers exact generic CSV provenance over incidental chain/address fields', () => {
    const csvAccount = account({ id: 'csv-account:generic', kind: 'csv', label: 'Generic history' });
    const walletAccount = account({ id: `wallet:evm:${EVM.toLowerCase()}`, kind: 'wallet', label: 'Wallet' });
    const indexes = buildSourcePresentationIndexes({
      accounts: [csvAccount, walletAccount],
      wallets: [wallet({ id: `ethereum:${EVM}`, chain: 'ethereum', address: EVM, accountIdentityId: walletAccount.id })],
      exchanges: [],
      csvImports: [csv({ id: 'generic-file', fileName: 'generic.csv', accountIdentityId: csvAccount.id })]
    });
    const result = sourcePresentationForTransaction(tx({
      id: 'generic', source: 'manual_mapping', importBatchId: 'generic-file', chain: 'ethereum', walletAddress: EVM
    }), indexes);
    expect(result).toMatchObject({ sourceKind: 'csv', status: 'resolved', accountKey: csvAccount.id, sourceKey: 'csv-source:generic-file' });
    const withoutWalletFields = sourcePresentationForTransaction(tx({
      id: 'generic-no-wallet', source: 'manual_mapping', importBatchId: 'generic-file'
    }), indexes);
    expect(withoutWalletFields).toMatchObject({ sourceKind: 'csv', status: 'resolved', sourceKey: 'csv-source:generic-file' });
  });

  it('does not treat incidental chain/address metadata as a wallet-import source', () => {
    const walletAccount = account({ id: `wallet:evm:${EVM.toLowerCase()}`, kind: 'wallet', label: 'Wallet' });
    const indexes = buildSourcePresentationIndexes({
      accounts: [walletAccount],
      wallets: [wallet({ id: `ethereum:${EVM}`, chain: 'ethereum', address: EVM, accountIdentityId: walletAccount.id })],
      exchanges: [], csvImports: []
    });
    const result = sourcePresentationForTransaction(tx({
      id: 'csv-metadata', source: 'manual_mapping', chain: 'ethereum', walletAddress: EVM
    }), indexes);
    expect(result).toMatchObject({ sourceKind: 'manual', status: 'resolved' });
    expect(result.sourceKind).not.toBe('wallet');
  });

  it('uses source exactness for overloaded import ids and otherwise stays unresolved', () => {
    const exchangeAccount = account({ id: 'exchange:shared', kind: 'exchange' });
    const csvAccount = account({ id: 'csv-account:shared', kind: 'csv' });
    const indexes = buildSourcePresentationIndexes({
      accounts: [exchangeAccount, csvAccount], wallets: [],
      exchanges: [exchange({ id: 'shared', exchange: 'binance', accountIdentityId: exchangeAccount.id })],
      csvImports: [csv({ id: 'shared', fileName: 'binance.csv', parserId: 'binance', accountIdentityId: csvAccount.id })]
    });
    expect(sourcePresentationForTransaction(tx({ id: 'api', source: 'binance_api', importBatchId: 'shared' }), indexes).sourceKind).toBe('exchange');
    expect(sourcePresentationForTransaction(tx({ id: 'csv', source: 'binance', importBatchId: 'shared' }), indexes).sourceKind).toBe('csv');
    expect(sourcePresentationForTransaction(tx({ id: 'ambiguous', source: 'unknown', importBatchId: 'shared' }), indexes).status).toBe('unresolved');
  });

  it('matches each exact member of a persisted + delimited parser set without prefix guessing', () => {
    const csvAccount = account({ id: 'csv-account:wazirx', kind: 'csv' });
    const indexes = buildSourcePresentationIndexes({
      accounts: [csvAccount], wallets: [], exchanges: [],
      csvImports: [csv({
        id: 'wazirx-mixed', fileName: 'wazirx.zip',
        parserId: 'wazirx_trades+wazirx_deposits', accountIdentityId: csvAccount.id
      })]
    });
    expect(sourcePresentationForTransaction(tx({ id: 'trades', source: 'wazirx_trades', importBatchId: 'wazirx-mixed' }), indexes)
      .sourceKey).toBe('csv-source:wazirx-mixed');
    expect(sourcePresentationForTransaction(tx({ id: 'deposits', source: 'wazirx_deposits', importBatchId: 'wazirx-mixed' }), indexes)
      .sourceKey).toBe('csv-source:wazirx-mixed');
    expect(sourcePresentationForTransaction(tx({ id: 'near', source: 'wazirx_trade', importBatchId: 'wazirx-mixed' }), indexes)
      .status).toBe('unresolved');
    expect(sourcePresentationForTransaction(tx({ id: 'prefix', source: 'wazirx', importBatchId: 'wazirx-mixed' }), indexes)
      .status).toBe('unresolved');
  });

  it('keeps a CSV survivor resolved while retaining valid linked deleted API provenance', () => {
    const csvAccount = account({ id: 'csv-account:survivor', kind: 'csv' });
    const indexes = buildSourcePresentationIndexes({
      accounts: [csvAccount], wallets: [], exchanges: [],
      csvImports: [csv({ id: 'survivor-file', fileName: 'survivor.csv', parserId: 'binance', accountIdentityId: csvAccount.id })]
    });
    const deletedSourceEvidence = {
      kind: 'deleted_exchange_source' as const, sourceIdentityId: 'deleted-api', transactionId: 'api-twin',
      source: 'binance_api', sourceRef: 'order-1', apiIdentity: 'safe-api-identity', deletedAt: 2
    };
    const result = sourcePresentationForTransaction(tx({
      id: 'survivor', source: 'binance', importBatchId: 'survivor-file', deletedSourceEvidence
    }), indexes);
    expect(result).toMatchObject({ sourceKind: 'csv', status: 'resolved', linkedDeletedSourceEvidence: deletedSourceEvidence });
  });

  it('marks deleted and unresolved sources honestly without brand guessing', () => {
    const empty = buildSourcePresentationIndexes({ accounts: [], wallets: [], exchanges: [], csvImports: [] });
    const deleted = sourcePresentationForTransaction(tx({
      id: 'deleted', source: 'binance_api', importBatchId: 'exc-gone',
      deletedSourceEvidence: {
        kind: 'deleted_exchange_source', sourceIdentityId: 'exc-gone', transactionId: 'deleted',
        source: 'binance_api', apiIdentity: 'safe-id', deletedAt: 2
      }
    }), empty);
    const unresolved = sourcePresentationForTransaction(tx({ id: 'unresolved', source: 'binance_api' }), empty);
    expect(deleted).toMatchObject({ status: 'deleted', primaryLabel: 'Deleted source', iconId: null });
    expect(unresolved).toMatchObject({ status: 'unresolved', primaryLabel: 'Unresolved source', iconId: null });
    expect(unresolved.sourceKey).toBe('unresolved-source:unresolved');
  });

  it('indexes 30k transaction presentations with linear exact-source lookups', () => {
    const accountRow = account({ id: 'exchange:exc-perf', kind: 'exchange', label: 'Performance account' });
    const indexes = buildSourcePresentationIndexes({
      accounts: [accountRow], wallets: [], csvImports: [],
      exchanges: [exchange({ id: 'exc-perf', exchange: 'binance', accountIdentityId: accountRow.id })]
    });
    const transactions = Array.from({ length: 30_000 }, (_, index) => tx({
      id: `perf-${index}`, source: 'binance_api', importBatchId: 'exc-perf'
    }));
    const started = performance.now();
    const presentations = buildTransactionSourcePresentations(transactions, indexes);
    const elapsed = performance.now() - started;
    expect(presentations.size).toBe(30_000);
    expect(presentations.get('perf-29999')?.sourceKey).toBe('exchange-source:exc-perf');
    expect(elapsed).toBeLessThan(1_500);
  });
});
