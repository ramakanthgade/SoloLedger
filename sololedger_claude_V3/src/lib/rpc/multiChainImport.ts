/**
 * Multi-chain wallet import: chain-picker checkbox state helpers + the
 * sequential import orchestrator.
 *
 * When Moralis chain detection finds an EVM wallet active on several chains,
 * one Import click runs the existing single-chain `runWalletImport` path once
 * per selected chain — SEQUENTIALLY, one chain at a time (explicit user ask:
 * ordered, paced provider calls instead of a burst) — and aggregates a
 * per-chain result summary. Already-imported (chain, address) pairs are
 * skipped the same way the single-chain flow skips them (pre-filtered against
 * the lookup-address registry, which `runWalletImport` re-checks internally).
 */
import { CHAINS, type ChainId } from '@/lib/rpc/providers';
import { importJob, runWalletImport } from '@/lib/importJob';
import { getLookupAddresses } from '@/lib/storage/db';
import { buildLookupConfig } from '@/lib/saas/lookupConfig';
import type { TaxSettings } from '@/types/transaction';

// ---- Chain-picker checkbox state ----

/** Every detected chain starts checked. */
export function defaultCheckedChains(detected: ChainId[]): Set<ChainId> {
  return new Set(detected);
}

/** Toggle one chain; returns a NEW set (state updates stay immutable). */
export function toggleChain(checked: Set<ChainId>, chainId: ChainId, on: boolean): Set<ChainId> {
  const next = new Set(checked);
  if (on) next.add(chainId);
  else next.delete(chainId);
  return next;
}

/** Master checkbox: check every detected chain, or clear all. */
export function setAllChains(detected: ChainId[], on: boolean): Set<ChainId> {
  return on ? new Set(detected) : new Set();
}

/** True when every detected chain is checked (drives the master checkbox). */
export function allChainsChecked(detected: ChainId[], checked: Set<ChainId>): boolean {
  return detected.length > 0 && detected.every((c) => checked.has(c));
}

/**
 * Merge a fresh detection result into the current checkbox state without
 * clobbering the user's choices: chains present before keep their checked /
 * unchecked state, newly detected chains default to checked, and chains that
 * disappeared are dropped.
 */
export function reconcileCheckedChains(
  prevChecked: Set<ChainId>,
  prevDetected: ChainId[],
  nextDetected: ChainId[]
): Set<ChainId> {
  const prev = new Set(prevDetected);
  const next = new Set<ChainId>();
  for (const chainId of nextDetected) {
    if (!prev.has(chainId) || prevChecked.has(chainId)) next.add(chainId);
  }
  return next;
}

// ---- Sequential multi-chain import ----

export interface ChainImportOutcome {
  chainId: ChainId;
  chainLabel: string;
  status: 'imported' | 'skipped' | 'failed';
  /** Transactions newly stored for this chain (0 for skipped/failed). */
  imported: number;
  /** Addresses skipped because this (chain, address) pair was already imported. */
  skippedAddresses: number;
  warnings: string[];
  failures: { address: string; message: string }[];
  error?: string;
}

export interface SequentialChainImportConfig {
  settings: TaxSettings;
  /** Same extras the single-chain flow forwards to buildLookupConfig. */
  lookupExtras: {
    customBaseUrl?: string;
    customApiKey?: string;
    customAsset?: string;
  };
  /** Progress hook fired just before each chain's import starts. */
  onChainStart?: (chainId: ChainId, index: number, total: number) => void;
}

/**
 * Import `addresses` on each of `chainIds`, ONE chain at a time, via the
 * existing runWalletImport path. A chain whose addresses are all already
 * imported is skipped (recorded, not called); a chain whose import throws is
 * recorded as failed and the remaining chains still run (fail soft). The
 * importJob singleton keeps its per-chain live progress as today; the
 * returned outcomes are the aggregated per-chain summary for display.
 */
export async function runSequentialChainImport(
  addresses: string[],
  chainIds: ChainId[],
  config: SequentialChainImportConfig
): Promise<ChainImportOutcome[]> {
  const outcomes: ChainImportOutcome[] = [];

  for (let i = 0; i < chainIds.length; i++) {
    const chainId = chainIds[i];
    const chain = CHAINS.find((c) => c.id === chainId);
    if (!chain) continue;

    // Re-read the registry per chain: earlier iterations may have just added
    // (chain, address) pairs, and a fresh read mirrors runWalletImport's own
    // already-imported check.
    // eslint-disable-next-line no-await-in-loop
    const existing = await getLookupAddresses();
    const known = new Set(
      existing.filter((r) => r.chain === chainId).map((r) => r.address.toLowerCase())
    );
    const fresh = addresses.filter((a) => !known.has(a.toLowerCase()));
    const skippedAddresses = addresses.length - fresh.length;

    if (fresh.length === 0) {
      outcomes.push({
        chainId,
        chainLabel: chain.label,
        status: 'skipped',
        imported: 0,
        skippedAddresses,
        warnings: [],
        failures: []
      });
      continue;
    }

    config.onChainStart?.(chainId, i, chainIds.length);
    try {
      // eslint-disable-next-line no-await-in-loop
      await runWalletImport(
        fresh,
        chain,
        config.settings,
        buildLookupConfig(chain, config.settings, config.lookupExtras)
      );
      const state = importJob.get();
      if (state.error) {
        outcomes.push({
          chainId,
          chainLabel: chain.label,
          status: 'failed',
          imported: state.result?.imported ?? 0,
          skippedAddresses,
          warnings: state.warnings,
          failures: state.failed,
          error: state.error
        });
      } else {
        outcomes.push({
          chainId,
          chainLabel: chain.label,
          status: 'imported',
          imported: state.result?.imported ?? 0,
          skippedAddresses,
          warnings: state.warnings,
          failures: state.failed
        });
      }
    } catch (err) {
      outcomes.push({
        chainId,
        chainLabel: chain.label,
        status: 'failed',
        imported: 0,
        skippedAddresses,
        warnings: [],
        failures: [],
        error: err instanceof Error ? err.message : 'Import failed.'
      });
    }
  }

  return outcomes;
}
