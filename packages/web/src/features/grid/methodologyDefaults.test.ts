import { describe, it, expect } from 'vitest';
import { methodologyDefaultMode } from './methodologyDefaults';

describe('methodologyDefaultMode', () => {
  it('AGILE → flat', () => {
    expect(methodologyDefaultMode('AGILE')).toBe('flat');
  });
  it('WATERFALL → outline', () => {
    expect(methodologyDefaultMode('WATERFALL')).toBe('outline');
  });
  it('HYBRID → outline', () => {
    expect(methodologyDefaultMode('HYBRID')).toBe('outline');
  });
});
