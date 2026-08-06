import type { NeutralDefiAction } from '@/lib/defi/types';
import { resolveProtocol } from '@/lib/defi/protocolRegistry';
import { isDerivativeTransaction, resolveDerivativesTreatment } from '@/lib/tax/derivatives';
import { resolveJurisdictionRules } from '@/lib/tax/jurisdictions';
import type { DerivativesTreatment, TaxSettings, Transaction } from '@/types/transaction';

export type TaxPolicyTreatment =
  | 'non_taxable'
  | 'income'
  | 'capital_gains'
  | 'business_income'
  | 'requires_review';

export interface TaxPolicyResolution {
  treatment: TaxPolicyTreatment;
  reason: string;
  confidence: number;
  jurisdiction: TaxSettings['jurisdiction'];
  derivativesTreatment?: DerivativesTreatment;
  evidenceIds: string[];
}

export type TaxPolicyInput =
  | { kind: 'transaction'; transaction: Transaction; settings: TaxSettings }
  | { kind: 'defi_action'; action: NeutralDefiAction; settings: TaxSettings }
  | { kind: 'derivatives'; settings: TaxSettings };

function review(input: TaxPolicyInput, reason: string, evidenceIds: string[] = []): TaxPolicyResolution {
  return {
    treatment: 'requires_review', reason, confidence: 0,
    jurisdiction: input.settings.jurisdiction, evidenceIds
  };
}

function resolveDefiPolicy(
  input: Extract<TaxPolicyInput, { kind: 'defi_action' }>
): TaxPolicyResolution {
  const { action, settings } = input;
  if (!action.complete) return review(input, 'DeFi action evidence is incomplete.', action.eventIds);
  if (!resolveProtocol(action.chainId, action.protocolId)) {
    return review(input, 'The chain or protocol is unsupported.', action.eventIds);
  }
  if (action.type === 'supply' || action.type === 'withdraw') {
    return review(input, 'Supply and withdrawal treatment is not validated for this jurisdiction.', action.eventIds);
  }
  if (action.type === 'borrow' || action.type === 'repay') {
    return {
      treatment: 'non_taxable',
      reason: action.type === 'borrow' ? 'Loan principal received is not income.' : 'Repayment reduces loan principal.',
      confidence: action.confidence, jurisdiction: settings.jurisdiction, evidenceIds: action.eventIds
    };
  }
  if (action.type === 'interest' || action.type === 'reward') {
    return {
      treatment: 'income', reason: 'Explicit interest or reward receipt is income at receipt.',
      confidence: action.confidence, jurisdiction: settings.jurisdiction, evidenceIds: action.eventIds
    };
  }
  return review(input, 'Liquidation requires transaction-specific proceeds and liability review.', action.eventIds);
}

/** Sole report-time policy resolver. It never mutates transactions or custody quantities. */
export function resolveTaxPolicy(input: TaxPolicyInput): TaxPolicyResolution {
  // Reading the validated registry here prevents a second jurisdiction table
  // from drifting from the reporting implementation.
  void resolveJurisdictionRules(input.settings.jurisdiction);
  if (input.kind === 'defi_action') return resolveDefiPolicy(input);
  const derivativesTreatment = resolveDerivativesTreatment(input.settings);
  if (input.kind === 'derivatives') {
    return {
      treatment: derivativesTreatment, derivativesTreatment,
      reason: 'Validated derivatives setting applied at report time.', confidence: 1,
      jurisdiction: input.settings.jurisdiction, evidenceIds: []
    };
  }
  const { transaction } = input;
  if (isDerivativeTransaction(transaction)) {
    return {
      treatment: derivativesTreatment, derivativesTreatment,
      reason: 'Validated derivatives setting applied at report time.', confidence: 1,
      jurisdiction: input.settings.jurisdiction, evidenceIds: [transaction.id]
    };
  }
  if (transaction.type === 'income') {
    return {
      treatment: 'income', reason: 'Typed income transaction.',
      confidence: transaction.categoryConfidence ?? 1,
      jurisdiction: input.settings.jurisdiction, evidenceIds: [transaction.id]
    };
  }
  if (transaction.type === 'sell' || transaction.type === 'trade' || transaction.type === 'nft_sell') {
    return {
      treatment: 'capital_gains', reason: 'Typed disposal transaction.', confidence: 1,
      jurisdiction: input.settings.jurisdiction, evidenceIds: [transaction.id]
    };
  }
  if (transaction.type === 'defi_deposit' || transaction.type === 'defi_withdraw') {
    return review(input, 'Historical DeFi action evidence is required.', [transaction.id]);
  }
  if (transaction.type === 'buy' || transaction.isInternalTransfer || transaction.internalTransferDecision === 'confirmed') {
    return {
      treatment: 'non_taxable', reason: transaction.type === 'buy'
        ? 'Asset acquisition is not a disposal.' : 'Confirmed internal custody movement.',
      confidence: 1, jurisdiction: input.settings.jurisdiction, evidenceIds: [transaction.id]
    };
  }
  return review(input, 'No validated automatic policy outcome exists for this transaction.', [transaction.id]);
}
