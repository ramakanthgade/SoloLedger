/**
 * Connection-wizard step machine (Task T3).
 *
 * The guided import flow is four ordered steps that mirror
 * `/.plans/designs/aurora-guided-import.html`:
 *
 *   1. pick      — choose the exchange/wallet source
 *   2. instructions — step-by-step CSV export instructions for that source
 *   3. upload    — drop the exported file
 *   4. preview   — validate the parsed rows, then confirm to persist
 *
 * This reducer is deliberately UI-free so the transitions can be unit-tested.
 * The critical rule it enforces is C1's missing gate: you can only reach
 * `preview` once a file has been read (`hasFile`), and you can only `confirm`
 * from `preview` — nothing persists to the ledger before an explicit confirm.
 */

export type WizardStep = 'pick' | 'instructions' | 'upload' | 'preview';

export const WIZARD_STEP_ORDER: WizardStep[] = [
  'pick',
  'instructions',
  'upload',
  'preview'
];

export interface WizardState {
  step: WizardStep;
  /** The chosen source id (e.g. 'coindcx'), or null before step 1 is done. */
  source: string | null;
  /** True once a file has been read into the preview. Gates `preview`. */
  hasFile: boolean;
  /** True once the user confirms — the signal to persist. */
  confirmed: boolean;
}

export const initialWizardState: WizardState = {
  step: 'pick',
  source: null,
  hasFile: false,
  confirmed: false
};

export type WizardAction =
  | { type: 'selectSource'; source: string }
  | { type: 'fileReady' }
  | { type: 'clearFile' }
  | { type: 'advance' }
  | { type: 'back' }
  | { type: 'preview' }
  | { type: 'confirm' }
  | { type: 'reset' };

function stepIndex(step: WizardStep): number {
  return WIZARD_STEP_ORDER.indexOf(step);
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'selectSource':
      // Picking (or changing) a source lands you on the instructions step and
      // resets any file already read for a previous source.
      return {
        ...state,
        source: action.source,
        step: 'instructions',
        hasFile: false,
        confirmed: false
      };

    case 'fileReady':
      // A file was parsed — enable the preview step. Never auto-confirms.
      return { ...state, hasFile: true, confirmed: false };

    case 'clearFile':
      // Drop the file and fall back to the upload step to try again.
      return {
        ...state,
        hasFile: false,
        confirmed: false,
        step: state.step === 'preview' ? 'upload' : state.step
      };

    case 'advance': {
      // Guard forward moves: no advancing past `pick` without a source, and no
      // reaching `preview` without a file read in.
      if (state.step === 'pick' && !state.source) return state;
      if (state.step === 'upload' && !state.hasFile) return state;
      const next = WIZARD_STEP_ORDER[Math.min(stepIndex(state.step) + 1, WIZARD_STEP_ORDER.length - 1)];
      return { ...state, step: next };
    }

    case 'back': {
      const prev = WIZARD_STEP_ORDER[Math.max(stepIndex(state.step) - 1, 0)];
      // Stepping back off the preview un-sets confirmation.
      return { ...state, step: prev, confirmed: false };
    }

    case 'preview':
      // Explicit jump to the validation gate — only allowed with a file.
      if (!state.hasFile) return state;
      return { ...state, step: 'preview', confirmed: false };

    case 'confirm':
      // Confirmation is only meaningful from the preview gate.
      if (state.step !== 'preview' || !state.hasFile) return state;
      return { ...state, confirmed: true };

    case 'reset':
      return { ...initialWizardState };

    default:
      return state;
  }
}
