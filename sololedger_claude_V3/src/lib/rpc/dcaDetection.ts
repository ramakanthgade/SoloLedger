/**
 * Jupiter DCA / Recurring order pattern detection and classification.
 *
 * How Jupiter DCA works on-chain:
 *   1. User sends input token (e.g. DBT) to a vault/DCA account.
 *   2. Jupiter keeper bots execute partial swaps from the vault periodically.
 *   3. Output token (e.g. USDC) is sent to the user's wallet in multiple fills.
 *
 * Tax treatment (Koinly / Awaken Tax / Indian VDA Section 115BBH standard):
 *   - Skip the initial deposit to the vault (non-taxable escrow).
 *   - Each fill = a TRADE: sold proportional input token, received output token.
 *   - Each fill sets its own cost basis for the acquired output token.
 *   - Capital gain = USDC proceeds (INR) − proportional DBT cost basis.
 *
 * Detection requires counterpartyAddress to be set (Solana wallet re-sync needed
 * for existing imports; new imports capture counterpartyAddress automatically).
 */
import type { Transaction, FlagReason } from '@/types/transaction';
import { db } from '@/lib/storage/db';
import { fetchJupiterRecurringHistory, toHumanAmount } from '@/lib/rpc/jupiterDca';

export interface DcaGroup {
  vaultAddress: string;
  depositTx: Transaction;
  fillTxs: Transaction[];
  inputAsset: string;
  outputAsset: string;
  totalInput: number;
  totalOutput: number;
}

/** Detect DCA vault patterns from a flat list of RPC-sourced transactions. */
export function detectDcaGroups(transactions: Transaction[]): DcaGroup[] {
  const byVault = new Map<string, { outs: Transaction[]; ins: Transaction[] }>();

  for (const t of transactions) {
    const vault = t.counterpartyAddress;
    if (!vault || !t.source.startsWith('rpc:') || t.isInternalTransfer || t.isSpam) continue;
    if (!byVault.has(vault)) byVault.set(vault, { outs: [], ins: [] });
    if (t.type === 'transfer_out') byVault.get(vault)!.outs.push(t);
    if (t.type === 'transfer_in') byVault.get(vault)!.ins.push(t);
  }

  const groups: DcaGroup[] = [];
  const ownWallets = new Set(transactions.map((t) => t.walletAddress?.toLowerCase()).filter(Boolean));

  for (const [vaultAddress, { outs, ins }] of byVault) {
    if (outs.length !== 1 || ins.length < 2) continue;
    const inputAsset = outs[0].asset;
    const outputAssets = new Set(ins.map((t) => t.asset));
    if (outputAssets.size !== 1) continue;
    const outputAsset = [...outputAssets][0];
    if (inputAsset === outputAsset) continue;
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
 * Apply DCA classification:
 * - Deposit tx → isInternalTransfer = true (escrow, non-taxable)
 * - Fill txs → type = 'trade':
 *     asset = inputAsset (what was sold, e.g. DBT)
 *     amount = proportional input amount per fill (from Jupiter API or estimated)
 *     counterAsset = outputAsset (what was received, e.g. USDC)
 *     counterAmount = fill output amount
 *
 * The cost basis engine matches the 'trade' disposal against open DBT lots
 * (created when DBT was classified as income from Dabba Foundation), computing
 * the correct capital gain.
 */
export async function applyDcaClassification(groups: DcaGroup[]): Promise<number> {
  if (groups.length === 0) return 0;
  let applied = 0;

  for (const g of groups) {
    // Try Jupiter Recurring API for exact DBT amounts per fill
    const walletAddress = g.depositTx.walletAddress;
    const jupiterData = walletAddress
      ? await fetchJupiterRecurringHistory(walletAddress)
      : { orders: [], fillsByTxId: new Map() };

    const totalOutput = g.fillTxs.reduce((s, t) => s + t.amount, 0);

    // Mark deposit as internal transfer (escrow into DCA vault, non-taxable)
    await db.transactions.update(g.depositTx.id, {
      isInternalTransfer: true,
      flags: [] as FlagReason[],
      notes:
        `DCA deposit: ${g.totalInput.toFixed(4)} ${g.inputAsset} → vault ` +
        `(${g.vaultAddress.slice(0, 8)}…${g.vaultAddress.slice(-4)}). ` +
        `Escrow — not a disposal. Proceeds recognised per fill below.`
    });

    // Reclassify each fill as a 'trade' (sell inputAsset, receive outputAsset)
    for (const fill of g.fillTxs) {
      // Look up exact amount from Jupiter API (matched by tx signature)
      const jupFill = fill.sourceRef ? jupiterData.fillsByTxId.get(fill.sourceRef) : null;
      let inputAmountPerFill: number;

      if (jupFill) {
        // Exact amount from Jupiter API
        inputAmountPerFill = jupFill.fill.inputAmount > 0
          ? jupFill.fill.inputAmount
          : toHumanAmount(jupFill.fill.rawInputAmount, jupFill.order.inputMint);
      } else {
        // Proportional estimate: input allocated proportional to output received
        inputAmountPerFill =
          totalOutput > 0
            ? (fill.amount / totalOutput) * g.totalInput
            : g.totalInput / g.fillTxs.length;
      }

      await db.transactions.update(fill.id, {
        type: 'trade',
        // The disposal (what was sold from DBT lot)
        asset: g.inputAsset,
        amount: parseFloat(inputAmountPerFill.toFixed(6)),
        // The acquisition (what was received: USDC)
        counterAsset: g.outputAsset,
        counterAmount: fill.amount,
        // contractAddress: preserve the output token's mint (from the fill tx)
        contractAddress: fill.contractAddress,
        flags: [] as FlagReason[],
        notes:
          `DCA fill: sold ${inputAmountPerFill.toFixed(4)} ${g.inputAsset} for ` +
          `${fill.amount.toFixed(4)} ${g.outputAsset}` +
          (jupFill ? ' (exact from Jupiter API)' : ' (proportional estimate)')
      });
    }
    applied++;
  }

  return applied;
}
