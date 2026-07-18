import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IMPORT_SOURCES, getImportSource } from './importSources';
import { ConnectionWizard } from './ConnectionWizard';

describe('IMPORT_SOURCES — "Other / any exchange" catalog entry', () => {
  it('includes an "other" entry rendered last with exchange-agnostic steps', () => {
    const other = getImportSource('other');
    expect(other).toBeDefined();
    expect(other!.label).toBe('Other / any exchange');
    expect(other!.region).toBe('global');
    // Rendered last (global tiles come after india; "other" is the final global one).
    expect(IMPORT_SOURCES[IMPORT_SOURCES.length - 1].id).toBe('other');
    // Steps are generic, not keyed to a named exchange.
    expect(other!.steps.length).toBeGreaterThanOrEqual(3);
    expect(other!.steps.join(' ')).toMatch(/read the columns automatically/i);
  });

  it('keeps the named-exchange tiles alongside the generic option', () => {
    const ids = IMPORT_SOURCES.map((s) => s.id);
    expect(ids).toContain('coindcx');
    expect(ids).toContain('binance');
    expect(ids).toContain('other');
  });
});

describe('ConnectionWizard picker renders the "Other" tile', () => {
  it('renders every source tile including "Other / any exchange"', () => {
    render(<ConnectionWizard />);
    // The picker maps over IMPORT_SOURCES with no special-casing per id.
    for (const s of IMPORT_SOURCES) {
      expect(screen.getByText(s.label)).toBeInTheDocument();
    }
    expect(screen.getByText('Other / any exchange')).toBeInTheDocument();
  });
});
