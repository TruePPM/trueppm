import { describe, it, expect } from 'vitest';
import { methodologyLabel, methodologyStatusLabel } from './methodologyLabel';

describe('methodologyLabel', () => {
  it('returns the bare display word for each preset', () => {
    expect(methodologyLabel('AGILE')).toBe('Agile');
    expect(methodologyLabel('WATERFALL')).toBe('Waterfall');
    expect(methodologyLabel('HYBRID')).toBe('Hybrid');
  });
});

// #2619: the shell used to render bare `"${label} workspace"` regardless of
// whether the value shown described this project's own resolved methodology or
// a genuine workspace-wide default — mislabeling a per-project value as the
// workspace's. `methodologyStatusLabel` replaces that with a phrase that only
// ever asserts what the available `effective`/`inherited` fields can prove.
describe('methodologyStatusLabel', () => {
  it('never says "workspace" as a bare suffix — states the methodology plainly', () => {
    expect(methodologyStatusLabel('HYBRID')).toBe('Hybrid methodology');
    expect(methodologyStatusLabel('WATERFALL')).toBe('Waterfall methodology');
  });

  it('appends the qualifier when the project matches the workspace default', () => {
    expect(methodologyStatusLabel('HYBRID', 'HYBRID')).toBe(
      'Hybrid methodology (workspace default)',
    );
  });

  it('omits the qualifier when the project overrides the workspace default', () => {
    expect(methodologyStatusLabel('WATERFALL', 'HYBRID')).toBe('Waterfall methodology');
  });

  it('omits the qualifier when inherited is unknown (undefined) rather than guessing', () => {
    expect(methodologyStatusLabel('AGILE', undefined)).toBe('Agile methodology');
  });
});
