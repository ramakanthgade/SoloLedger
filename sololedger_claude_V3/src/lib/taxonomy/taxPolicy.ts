import type { NeutralDefiAction } from '@/lib/defi/types';
import { exactStoredDefiAction } from '@/lib/defi/actionEvidence';
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
  /** Stable machine-readable audit key. Never derive report behavior from prose. */
  reasonCode: TaxPolicyReasonCode;
  /** Stable user-facing policy explanation. */
  explanation: string;
  policyVersion: typeof TAX_POLICY_VERSION;
  /** @deprecated Use explanation. Retained for export/UI compatibility. */
  reason: string;
  confidence: number;
  jurisdiction: TaxSettings['jurisdiction'];
  derivativesTreatment?: DerivativesTreatment;
  evidenceIds: string[];
}

export const TAX_POLICY_VERSION = 'b5.1' as const;

export type TaxPolicyReasonCode =
  | 'confirmed_internal_transfer'
  | 'asset_acquisition'
  | 'typed_income_receipt'
  | 'typed_disposal'
  | 'loan_principal'
  | 'crypto_loan_repayment_unsupported'
  | 'gift_received_unsupported'
  | 'gift_sent_unsupported'
  | 'transaction_fee'
  | 'derivatives_business_income'
  | 'derivatives_capital_gains'
  | 'options_lifecycle_unsupported'
  | 'derivative_collateral'
  | 'derivative_cashflow_unsupported'
  | 'defi_evidence_incomplete'
  | 'defi_protocol_unsupported'
  | 'defi_supply_withdraw_unsupported'
  | 'defi_loan_principal'
  | 'defi_income_receipt'
  | 'defi_liquidation_unsupported'
  | 'suggestion_pending'
  | 'unsupported_transaction';

export type TaxPolicyInput =
  | { kind: 'transaction'; transaction: Transaction; settings: TaxSettings }
  | { kind: 'defi_action'; action: NeutralDefiAction; settings: TaxSettings }
  | { kind: 'derivatives'; settings: TaxSettings };

function resolution(
  input: TaxPolicyInput,
  treatment: TaxPolicyTreatment,
  reasonCode: TaxPolicyReasonCode,
  explanation: string,
  confidence: number,
  evidenceIds: string[] = [],
  derivativesTreatment?: DerivativesTreatment
): TaxPolicyResolution {
  return {
    treatment, reasonCode, explanation, reason: explanation, policyVersion: TAX_POLICY_VERSION,
    confidence, jurisdiction: input.settings.jurisdiction, evidenceIds, derivativesTreatment
  };
}


function review(input: TaxPolicyInput, reasonCode: TaxPolicyReasonCode, explanation: string, evidenceIds: string[] = []): TaxPolicyResolution {
  return resolution(input, 'requires_review', reasonCode, explanation, 0, evidenceIds);
}

function resolveDefiPolicy(
  input: Extract<TaxPolicyInput, { kind: 'defi_action' }>
): TaxPolicyResolution {
  const { action, settings } = input;
  if (!action.complete) return review(input, 'defi_evidence_incomplete', 'DeFi action evidence is incomplete.', action.eventIds);
  if (!resolveProtocol(action.chainId, action.protocolId)) {
    return review(input, 'defi_protocol_unsupported', 'The chain or protocol is unsupported.', action.eventIds);
  }
  if (action.type === 'supply' || action.type === 'withdraw') {
    return review(input, 'defi_supply_withdraw_unsupported', 'Supply and withdrawal treatment is not validated for this jurisdiction.', action.eventIds);
  }
  if (action.type === 'borrow') {
    return resolution(input, 'non_taxable', 'defi_loan_principal',
      'Loan principal received is not income.',
      action.confidence, action.eventIds);
  }
  if (action.type === 'repay') {
    return review(input, 'crypto_loan_repayment_unsupported',
      'Liability principal reduction is non-taxable, but the outgoing crypto disposal requires jurisdiction-specific review.',
      action.eventIds);
  }
  if (action.type === 'interest' && action.interestKind === 'borrowing') {
    return resolution(input, 'non_taxable', 'transaction_fee', 'Explicit borrowing interest is a loan expense, not income.',
      action.confidence, action.eventIds);
  }
  if (action.type === 'interest' || action.type === 'reward') {
    return resolution(input, 'income', 'defi_income_receipt', 'Explicit interest or reward receipt is income at receipt.',
      action.confidence, action.eventIds);
  }
  void settings;
  return review(input, 'defi_liquidation_unsupported', 'Liquidation requires transaction-specific proceeds and liability review.', action.eventIds);
}

/** Sole report-time policy resolver. It never mutates transactions or custody quantities. */
export function resolveTaxPolicy(input: TaxPolicyInput): TaxPolicyResolution {
  // Reading the validated registry here prevents a second jurisdiction table
  // from drifting from the reporting implementation.
  void resolveJurisdictionRules(input.settings.jurisdiction);
  if (input.kind === 'defi_action') return resolveDefiPolicy(input);
  const derivativesTreatment = resolveDerivativesTreatment(input.settings);
  if (input.kind === 'derivatives') {
    return resolution(input, derivativesTreatment,
      derivativesTreatment === 'business_income' ? 'derivatives_business_income' : 'derivatives_capital_gains',
      'Validated derivatives setting applied at report time.', 1, [], derivativesTreatment);
  }
  const { transaction } = input;
  if (transaction.raw && Object.prototype.hasOwnProperty.call(transaction.raw, 'defiActionEvidence')) {
    const action = exactStoredDefiAction(transaction.raw.defiActionEvidence, transaction);
    if (!action) {
      return review(input, 'defi_evidence_incomplete', 'Stored DeFi receipt evidence failed exact validation.', [transaction.id]);
    }
    return resolveDefiPolicy({ kind: 'defi_action', action, settings: input.settings });
  }
  if (transaction.categoryOrigin === 'suggestion' && !transaction.categoryLocked) {
    return review(input, 'suggestion_pending', 'Suggested classification requires user confirmation.', [transaction.id]);
  }
  if (transaction.category === 'options_premium') {
    return review(input, 'options_lifecycle_unsupported',
      'Options premium requires expiry, exercise, assignment, or close lifecycle matching.', [transaction.id]);
  }
  if (transaction.category === 'options_collateral' || transaction.category === 'derivative_collateral') {
    return review(input, 'derivative_collateral',
      'Derivative collateral movement is not a realized tax outcome.', [transaction.id]);
  }
  if (derivativesTreatment === 'capital_gains' && (
    transaction.category === 'funding_fee' || transaction.category === 'futures_fee' ||
    transaction.category === 'options_fee' || transaction.category === 'realized_pnl'
  )) {
    return review(input, 'derivative_cashflow_unsupported',
      'This derivative cash flow lacks validated open/close lifecycle evidence for capital-gains presentation.', [transaction.id]);
  }
  if (isDerivativeTransaction(transaction)) {
    return resolution(input, derivativesTreatment,
      derivativesTreatment === 'business_income' ? 'derivatives_business_income' : 'derivatives_capital_gains',
      'Validated derivatives setting applied at report time.', 1, [transaction.id], derivativesTreatment);
  }
  if (transaction.category === 'loan' || transaction.category === 'margin_loan') {
    return resolution(input, 'non_taxable', 'loan_principal', 'Loan principal received is not income.', 1, [transaction.id]);
  }
  if (transaction.category === 'loan_repayment' || transaction.category === 'margin_repayment') {
    return review(input, 'crypto_loan_repayment_unsupported',
      'Crypto loan repayment requires jurisdiction-supported principal, interest, and collateral evidence.', [transaction.id]);
  }
  if (transaction.type === 'fee') {
    return resolution(input, 'non_taxable', 'transaction_fee',
      'Transaction fee is excluded from gains; jurisdiction fee-basis rules are applied separately.', 1, [transaction.id]);
  }
  if (transaction.type === 'gift_received') {
    return review(input, 'gift_received_unsupported',
      'Gift receipt treatment requires explicit jurisdiction-supported donor and valuation evidence.', [transaction.id]);
  }
  if (transaction.type === 'gift_sent') {
    return review(input, 'gift_sent_unsupported',
      'Gift transfer treatment requires explicit jurisdiction-supported recipient and disposition evidence.', [transaction.id]);
  }
  if (transaction.type === 'income') {
    return resolution(input, 'income', 'typed_income_receipt', 'Typed income transaction.',
      transaction.categoryConfidence ?? 1, [transaction.id]);
  }
  if (transaction.type === 'sell' || transaction.type === 'trade' || transaction.type === 'nft_sell') {
    return resolution(input, 'capital_gains', 'typed_disposal', 'Typed disposal transaction.', 1, [transaction.id]);
  }
  if (transaction.type === 'defi_deposit' || transaction.type === 'defi_withdraw') {
    return review(input, 'defi_supply_withdraw_unsupported', 'Historical DeFi action evidence is required.', [transaction.id]);
  }
  if (transaction.type === 'buy' || transaction.type === 'nft_buy' || transaction.type === 'nft_mint' || transaction.isInternalTransfer || transaction.internalTransferDecision === 'confirmed') {
    const acquisition = transaction.type === 'buy' || transaction.type === 'nft_buy' || transaction.type === 'nft_mint';
    return resolution(input, 'non_taxable', acquisition ? 'asset_acquisition' : 'confirmed_internal_transfer',
      acquisition ? 'Asset acquisition is not a disposal.' : 'Confirmed internal custody movement.', 1, [transaction.id]);
  }
  return review(input, 'unsupported_transaction', 'No validated automatic policy outcome exists for this transaction.', [transaction.id]);
}
