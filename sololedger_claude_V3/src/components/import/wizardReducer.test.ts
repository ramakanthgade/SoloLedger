import { describe, it, expect } from 'vitest';
import {
  wizardReducer,
  initialWizardState,
  type WizardState
} from './wizardReducer';

describe('wizardReducer', () => {
  it('starts on the pick step with no source, file, or confirmation', () => {
    expect(initialWizardState).toEqual({
      step: 'pick',
      source: null,
      hasFile: false,
      confirmed: false
    });
  });

  it('selecting a source moves to the instructions step', () => {
    const next = wizardReducer(initialWizardState, { type: 'selectSource', source: 'coindcx' });
    expect(next.source).toBe('coindcx');
    expect(next.step).toBe('instructions');
  });

  it('does not advance past pick without a source', () => {
    const next = wizardReducer(initialWizardState, { type: 'advance' });
    expect(next.step).toBe('pick');
  });

  it('advances instructions → upload once a source is chosen', () => {
    const picked = wizardReducer(initialWizardState, { type: 'selectSource', source: 'wazirx' });
    const next = wizardReducer(picked, { type: 'advance' });
    expect(next.step).toBe('upload');
  });

  it('does not reach preview from upload without a file', () => {
    const atUpload: WizardState = { step: 'upload', source: 'zebpay', hasFile: false, confirmed: false };
    expect(wizardReducer(atUpload, { type: 'advance' }).step).toBe('upload');
    expect(wizardReducer(atUpload, { type: 'preview' }).step).toBe('upload');
  });

  it('advances upload → preview once a file is ready', () => {
    const atUpload: WizardState = { step: 'upload', source: 'coindcx', hasFile: false, confirmed: false };
    const withFile = wizardReducer(atUpload, { type: 'fileReady' });
    expect(withFile.hasFile).toBe(true);
    const previewing = wizardReducer(withFile, { type: 'advance' });
    expect(previewing.step).toBe('preview');
  });

  it('preview action jumps straight to the preview gate when a file exists', () => {
    const atUpload: WizardState = { step: 'upload', source: 'coindcx', hasFile: true, confirmed: false };
    expect(wizardReducer(atUpload, { type: 'preview' }).step).toBe('preview');
  });

  it('back steps to the previous step and clears confirmation', () => {
    const atPreview: WizardState = { step: 'preview', source: 'coindcx', hasFile: true, confirmed: true };
    const back = wizardReducer(atPreview, { type: 'back' });
    expect(back.step).toBe('upload');
    expect(back.confirmed).toBe(false);
  });

  it('back from pick stays on pick (no underflow)', () => {
    expect(wizardReducer(initialWizardState, { type: 'back' }).step).toBe('pick');
  });

  it('confirm only sets confirmed from the preview step with a file', () => {
    const atPreview: WizardState = { step: 'preview', source: 'coindcx', hasFile: true, confirmed: false };
    expect(wizardReducer(atPreview, { type: 'confirm' }).confirmed).toBe(true);

    const atUpload: WizardState = { step: 'upload', source: 'coindcx', hasFile: true, confirmed: false };
    expect(wizardReducer(atUpload, { type: 'confirm' }).confirmed).toBe(false);
  });

  it('clearing a file from preview falls back to the upload step', () => {
    const atPreview: WizardState = { step: 'preview', source: 'coindcx', hasFile: true, confirmed: false };
    const cleared = wizardReducer(atPreview, { type: 'clearFile' });
    expect(cleared.hasFile).toBe(false);
    expect(cleared.step).toBe('upload');
  });

  it('changing source resets the file and confirmation', () => {
    const atPreview: WizardState = { step: 'preview', source: 'coindcx', hasFile: true, confirmed: true };
    const changed = wizardReducer(atPreview, { type: 'selectSource', source: 'binance' });
    expect(changed.source).toBe('binance');
    expect(changed.step).toBe('instructions');
    expect(changed.hasFile).toBe(false);
    expect(changed.confirmed).toBe(false);
  });

  it('reset returns to the initial state', () => {
    const dirty: WizardState = { step: 'preview', source: 'mudrex', hasFile: true, confirmed: true };
    expect(wizardReducer(dirty, { type: 'reset' })).toEqual(initialWizardState);
  });
});
