export type SafetyState =
  | 'trusted'
  | 'high_confidence_spam'
  | 'unverified'
  | 'user_hidden'
  | 'user_visible';

export type SafetySubjectKind = 'asset' | 'event';

export interface ProviderEvidenceRow {
  id: string;
  subjectKey: string;
  subjectKind: SafetySubjectKind;
  provider: string;
  ruleId: string;
  ruleVersion: string;
  confidence: number;
  observedAt: number;
  /** Provider response fields not understood by this app. Kept local and losslessly backed up. */
  raw?: Record<string, unknown>;
}

export interface SafetyDecisionRow {
  subjectKey: string;
  state: SafetyState;
  updatedAt: number;
  reason?: string;
  evidenceIds?: string[];
  origin: 'automatic' | 'user' | 'migration';
  /** Required audit link when a user restores an automatically excluded subject. */
  previousAutomaticState?: Extract<SafetyState, 'high_confidence_spam'>;
}

export interface SafetyResolution {
  state: SafetyState;
  excluded: boolean;
  warned: boolean;
  exactContractPriceOnly: boolean;
  evidenceIds: string[];
  automaticEvidence?: Pick<ProviderEvidenceRow, 'provider' | 'ruleId' | 'ruleVersion' | 'confidence'>;
}

export const AUTOMATIC_SPAM_THRESHOLD = 0.9;

export function isExcludedSafetyState(state: SafetyState): boolean {
  return state === 'high_confidence_spam' || state === 'user_hidden';
}
