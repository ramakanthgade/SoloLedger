import type { NeutralDefiAction } from '@/lib/defi/types';
import { exactStoredDefiAction } from '@/lib/defi/actionEvidence';
import { PROTOCOL_REGISTRY } from '@/lib/defi/protocolRegistry';
import { applyClassificationEvidence } from '@/lib/taxonomy/classification';
import type { ClassificationEvidence, Transaction, TransactionCategory, TxType } from '@/types/transaction';

export interface DefiEnrichmentDiagnostics {
  candidates: number;
  enriched: number;
  suppressedEvidenceLegs: number;
  timedOut: number;
  failed: number;
  notFound: number;
  httpFailed: number;
  networkFailed: number;
  malformed: number;
  materializationFailed: number;
  partial: boolean;
}

export interface DefiReceiptEnrichmentResult {
  transactions: Transaction[];
  diagnostics: DefiEnrichmentDiagnostics;
}

function isReceiptAnalysis(
  value: readonly NeutralDefiAction[] | DefiReceiptAnalysis
): value is DefiReceiptAnalysis {
  return !Array.isArray(value);
}

function rowEventId(row: Transaction): string | undefined {
  const event = row.onchainTransferEvent;
  if (!event || event.indexKind !== 'log' || !row.txHash || !row.contractAddress) return undefined;
  return `event:1:${row.txHash.toLowerCase()}:${row.contractAddress.toLowerCase()}:${Number(event.index)}`;
}

function inferredDecimals(row: Transaction | undefined): number | undefined {
  const raw = row?.raw;
  const token = raw?.token && typeof raw.token === 'object' ? raw.token as Record<string, unknown> : undefined;
  const rawContract = raw?.rawContract && typeof raw.rawContract === 'object'
    ? raw.rawContract as Record<string, unknown> : undefined;
  // Alchemy's Asset Transfers response uses singular `rawContract.decimal`.
  // Keep the other provider shapes as exact metadata fallbacks.
  const rawDecimals = Number(token?.decimals ?? rawContract?.decimal ?? rawContract?.decimals ?? raw?.decimals);
  if (Number.isSafeInteger(rawDecimals) && rawDecimals >= 0 && rawDecimals <= 255) return rawDecimals;
  const amount = row?.amount;
  if (amount == null || amount < 0 || !Number.isFinite(amount)) return undefined;
  const eventQuantity = row?.onchainTransferEvent?.quantity;
  if (!eventQuantity || !/^[0-9]+$/.test(eventQuantity)) return undefined;
  const quantity = BigInt(eventQuantity);
  const matches: number[] = [];
  for (let decimals = 0; decimals <= 36; decimals++) {
    const display = Number(quantity) / 10 ** decimals;
    if (!Number.isFinite(display)) continue;
    const scale = Math.max(Math.abs(display), Math.abs(amount));
    // Relative floating-point reconstruction only: never introduce an
    // absolute floor that makes unrelated dust quantities appear equal.
    const tolerance = scale === 0 ? 0 : Math.max(Number.MIN_VALUE, scale * Number.EPSILON * 2);
    if (Object.is(display, amount) || Math.abs(display - amount) <= tolerance) matches.push(decimals);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function semantic(action: NeutralDefiAction): { type: TxType; category: TransactionCategory } | undefined {
  if (action.type === 'borrow') return { type: 'transfer_in', category: 'loan' };
  if (action.type === 'repay') return { type: 'transfer_out', category: 'loan_repayment' };
  if (action.type === 'interest' && action.interestKind === 'lending') {
    return { type: 'income', category: 'lending_interest' };
  }
  if (action.type === 'interest' && action.interestKind === 'borrowing') {
    return { type: 'fee', category: 'loan_fee' };
  }
  return undefined;
}

function evidence(action: NeutralDefiAction, observedAt: number): ClassificationEvidence[] {
  const classification = semantic(action);
  if (!classification || !action.ruleId || !action.ruleVersion) return [];
  return [{
    ...classification, origin: 'rule', confidence: action.confidence,
    ruleId: action.ruleId, ruleVersion: action.ruleVersion, observedAt, allowlisted: true,
    explanation: 'Exact supported protocol receipt event and represented economic leg.'
  }];
}

function displayAmount(rawQuantity: string, decimals: number): number {
  return Number(rawQuantity) / 10 ** decimals;
}

/**
 * Materialize exact actions independently of the history provider. Mapped
 * aToken/debt-token mint and burn rows are evidence, not liquid custody.
 */
export function materializeExactDefiActions(
  rows: readonly Transaction[],
  actions: readonly NeutralDefiAction[]
): {
  transactions: Transaction[];
  enriched: number;
  suppressedEvidenceLegs: number;
  materializationFailed: number;
} {
  const replacements = new Map<string, Transaction>();
  const suppressed = new Set<string>();
  const synthetic: Transaction[] = [];
  let enriched = 0;
  let materializationFailed = 0;

  for (const candidate of actions) {
    const action = exactStoredDefiAction(candidate);
    if (!action || !semantic(action)) continue;
    const mappedLegs = (action.economicLegs ?? []).filter((leg) =>
      leg.kind === 'protocol_token' || leg.kind === 'debt_token');
    const representedRows = rows.filter((row) => {
      const id = rowEventId(row);
      return id != null && mappedLegs.some((leg) => leg.eventId === id);
    });

    if (action.type === 'interest') {
      const anchorId = action.postingAnchorEventId;
      const mint = mappedLegs.find((leg) => leg.direction === 'mint' && leg.eventId === anchorId);
      const represented = anchorId ? rows.find((row) => rowEventId(row) === anchorId) : undefined;
      const decimals = inferredDecimals(represented);
      if (!mint || !represented || decimals == null) {
        materializationFailed++;
        continue;
      }
      const anchored = {
        ...action,
        postingAnchor: true,
        postingAnchorEventId: mint.eventId,
        postingAnchorRawQuantity: action.quantity,
        postingAnchorDecimals: decimals
      } satisfies NeutralDefiAction;
      const classification = semantic(anchored)!;
      const base: Transaction = {
        ...represented,
        id: `${represented.id}:defi-interest:${action.interestKind}`,
        sourceRef: `defi:interest:${mint.eventId}`,
        type: classification.type,
        category: undefined,
        categoryOrigin: undefined,
        categoryConfidence: undefined,
        categoryRuleId: undefined,
        categoryRuleVersion: undefined,
        categoryLocked: false,
        classificationEvidence: [],
        asset: represented.asset.replace(/^(variableDebt|stableDebt|aEth|a)/i, '') || represented.asset,
        amount: displayAmount(action.quantity, decimals),
        contractAddress: action.reserveKey,
        counterpartyAddress: action.callEvidence?.to,
        onchainTransferEvent: undefined,
        flags: represented.flags.filter((flag) => flag !== 'possible_internal_transfer' &&
          flag !== 'needs_review' && flag !== 'missing_market_value'),
        raw: { ...represented.raw, syntheticDefiComponent: true, defiActionEvidence: anchored }
      };
      synthetic.push(applyClassificationEvidence(base, evidence(anchored, represented.timestamp), represented.timestamp));
      for (const row of representedRows) suppressed.add(row.id);
      enriched++;
      continue;
    }

    const anchorId = action.postingAnchorEventId;
    const anchorLeg = action.economicLegs?.find((leg) => leg.eventId === anchorId && leg.kind === 'underlying');
    const represented = anchorId ? rows.find((row) => rowEventId(row) === anchorId) : undefined;
    const decimals = inferredDecimals(represented);
    if (!anchorLeg || !represented || decimals == null) {
      materializationFailed++;
      continue;
    }
    const anchored = {
      ...action, postingAnchor: true,
      postingAnchorRawQuantity: action.quantity, postingAnchorDecimals: decimals
    } satisfies NeutralDefiAction;
    const transfer = represented.onchainTransferEvent;
    const base: Transaction = {
      ...represented,
      category: undefined,
      categoryOrigin: undefined,
      categoryConfidence: undefined,
      categoryRuleId: undefined,
      categoryRuleVersion: undefined,
      categoryLocked: false,
      classificationEvidence: represented.classificationEvidence ?? [],
      amount: displayAmount(action.quantity, decimals),
      onchainTransferEvent: transfer ? { ...transfer, quantity: action.quantity } : transfer,
      flags: represented.flags.filter((flag) => flag !== 'possible_internal_transfer' &&
        flag !== 'needs_review' && flag !== 'missing_market_value'),
      raw: { ...represented.raw, defiActionEvidence: anchored }
    };
    replacements.set(represented.id,
      applyClassificationEvidence(base, evidence(anchored, represented.timestamp), represented.timestamp));
    for (const row of representedRows) suppressed.add(row.id);
    suppressed.delete(represented.id);
    enriched++;
  }

  return {
    transactions: [
      ...rows.filter((row) => !suppressed.has(row.id)).map((row) => replacements.get(row.id) ?? row),
      ...synthetic
    ],
    enriched,
    suppressedEvidenceLegs: suppressed.size,
    materializationFailed
  };
}

function candidateHashes(rows: readonly Transaction[]): string[] {
  const pools = new Set(Object.values(PROTOCOL_REGISTRY).map((entry) => entry.poolAddress.toLowerCase()));
  return [...new Set(rows.filter((row) => row.chain === 'ethereum' && row.txHash && (
    row.raw?.defiActionEvidence != null || pools.has(row.counterpartyAddress?.toLowerCase() ?? '')
  )).map((row) => row.txHash!.toLowerCase()))];
}

export async function enrichEthereumDefiTransactions(
  rows: readonly Transaction[],
  loadActions: (
    hash: string,
    signal?: AbortSignal
  ) => Promise<readonly NeutralDefiAction[] | DefiReceiptAnalysis>,
  options: { concurrency?: number; timeoutMs?: number; candidateHashes?: readonly string[] } = {}
): Promise<DefiReceiptEnrichmentResult> {
  const hashes = options.candidateHashes
    ? [...new Set(options.candidateHashes.map((hash) => hash.toLowerCase()))]
    : candidateHashes(rows);
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 4));
  const timeoutMs = Math.max(1, options.timeoutMs ?? 8_000);
  const actions: NeutralDefiAction[] = [];
  const completedBindings = new Map<string, Transaction>();
  let next = 0;
  let started = 0;
  let halted = false;
  let timedOut = 0;
  let failed = 0;
  let notFound = 0;
  let httpFailed = 0;
  let networkFailed = 0;
  let malformed = 0;
  const workers = Array.from({ length: Math.min(concurrency, hashes.length) }, async () => {
    while (next < hashes.length && !halted) {
      const hash = hashes[next++];
      started++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      try {
        const result = await Promise.race([
          loadActions(hash, controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('receipt_timeout')), timeoutMs);
          })
        ]);
        if (isReceiptAnalysis(result)) {
          actions.push(...result.actions);
          for (const binding of result.bindings ?? []) completedBindings.set(binding.id, binding);
        } else actions.push(...result);
      } catch (error) {
        if (error instanceof Error && error.message === 'receipt_timeout') {
          timedOut++;
          controller.abort();
          // A generic promise cannot be force-cancelled safely. Stop launching
          // further receipts so timed-out work never defeats the concurrency
          // bound; unstarted candidates remain explicitly partial/retryable.
          halted = true;
        }
        else {
          failed++;
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith('receipt_not_found')) notFound++;
          else if (message.startsWith('receipt_http')) httpFailed++;
          else if (message.startsWith('receipt_network')) networkFailed++;
          else if (message.startsWith('receipt_malformed')) malformed++;
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  });
  await Promise.all(workers);
  timedOut += hashes.length - started;
  const boundRows = rows.map((row) => completedBindings.get(row.id) ?? row);
  const materialized = materializeExactDefiActions(boundRows, actions);
  return {
    transactions: materialized.transactions,
    diagnostics: {
      candidates: hashes.length,
      enriched: materialized.enriched,
      suppressedEvidenceLegs: materialized.suppressedEvidenceLegs,
      timedOut,
      failed,
      notFound,
      httpFailed,
      networkFailed,
      malformed,
      materializationFailed: materialized.materializationFailed,
      partial: timedOut + failed + materialized.materializationFailed > 0
    }
  };
}

export interface DefiReceiptAnalysis {
  actions: readonly NeutralDefiAction[];
  /** Immutable replacements derived by analysis and accepted only before timeout. */
  bindings?: readonly Transaction[];
}
