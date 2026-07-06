/**
 * Jupiter DCA / Recurring order pattern detection.
 *
 * How Jupiter DCA works on-chain:
 *   1. User sends input token (e.g. DBT) to a vault/DCA account.
 *   2. Jupiter keeper bots execute partial swaps from the vault periodically.
 *   3. Output token (e.g. USDC) is sent to the user's wallet in multiple fills.
 *
 * Tax treatment (Koinly / Awaken Tax standard):
 *   - Skip the initial deposit to the vault (non-taxable escrow).
 *   - Each fill (USDC receipt from vault) = individual buy event with its own cost basis.
 *   - The DBT disposal is recognised proportionally at each fill.
 *
 * Detection criteria (requires counterpartyAddress to be set on transactions):
 *   - Same vault address appears as counterparty for exactly 1 transfer_out (input token)
 *     and 2+ transfer_in of a DIFFERENT token (output token).
 *   - Vault address is NOT another one of the user's known wallets.
 */
import type { Transaction, FlagReason } from '@/types/transaction';
import { db } from '@/lib/storage/db';

export interface DcaGroup {
  vaultAddress: string;
  /** The input-token deposit (e.g. 32,000 DBT → vault). Mark as internal. */
  depositTx: Transaction;
  /** Each fill received from vault (e.g. USDC). Reclassify as buy. */
  fillTxs: Transaction[];
  inputAsset: string;
  outputAsset: string;
  totalInput: number;
  totalOutput: number;
}

/** Detect DCA vault patterns from a flat list of RPC-sourced transactions. */
export function detectDcaGroups(transactions: Transaction[]): DcaGroup[] {
  // Group by counterpartyAddress (vault)
  const byVault = new Map<string, { outs: Transaction[]; ins: Transaction[] }>();

  for (const t of transactions) {
    const vault = t.counterpartyAddress;
    if (!vault || !t.source.startsWith('rpc:') || t.isInternalTransfer || t.isSpam) continue;
    if (!byVault.has(vault)) byVault.set(vault, { outs: [], ins: [] });
    if (t.type === 'transfer_out') byVault.get(vault)!.outs.push(t);
    if (t.type === 'transfer_in') byVault.get(vault)!.ins.push(t);
  }

  const groups: DcaGroup[] = [];

  for (const [vaultAddress, { outs, ins }] of byVault) {
    // Classic DCA: exactly 1 deposit out, 2+ fills in, different assets
    if (outs.length !== 1) continue;
    if (ins.length < 2) continue;

    const inputAsset = outs[0].asset;
    const outputAssets = new Set(ins.map((t) => t.asset));
    if (outputAssets.size !== 1) continue; // all fills must be same asset
    const outputAsset = [...outputAssets][0];
    if (inputAsset === outputAsset) continue; // must be different assets

    // Vault must NOT be one of the user's own wallets
    const ownWallets = new Set(transactions.map((t) => t.walletAddress?.toLowerCase()).filter(Boolean));
    if (ownWallets.has(vaultAddress.toLowerCase())) continue;

    groups.push({
      vaultAddress,
      depositTx: outs[0],
      fillTxs: ins.sort((a, b) => a.timestamp - b.timestamp),
      inputAsset,
      outputAsset,
      totalInput: outs[0].amount,
      totalOutput: ins.reduce((s, t) => s + t.amount, 0)
    });
  }

  return groups;
}

/**
 * Apply DCA classification to detected groups:
 * - Deposit tx → isInternalTransfer = true (escrow, non-taxable)
 * - Fill txs → type = 'buy' (acquisition of output token; cost basis = fiatValue at receipt time)
 */
export async function applyDcaClassification(groups: DcaGroup[]): Promise<number> {
  if (groups.length === 0) return 0;
  let applied = 0;

  for (const g of groups) {
    // Mark deposit as internal transfer (escrow into DCA vault, not a disposal)
    await db.transactions.update(g.depositTx.id, {
      isInternalTransfer: true,
      flags: [] as FlagReason[],
      notes: `DCA deposit: ${g.totalInput} ${g.inputAsset} → vault (${g.vaultAddress.slice(0, 8)}…)`
    });

    // Reclassify each fill as 'buy' — proceeds from DCA vault selling your input token
    for (const fill of g.fillTxs) {
      await db.transactions.update(fill.id, {
        type: 'buy',
        flags: (fill.flags ?? []).filter((f) => f !== 'possible_internal_transfer') as FlagReason[],
        notes: `DCA fill: received ${fill.amount} ${g.outputAsset} (sold proportional ${g.inputAsset})`
      });
    }
    applied++;
  }

  return applied;
}
