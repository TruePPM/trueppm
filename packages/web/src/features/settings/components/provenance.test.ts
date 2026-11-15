import { describe, it, expect } from 'vitest';
import {
  INHERIT_SOURCE,
  inheritedFrom,
  inheritedFromLead,
  inheritedFromPhrase,
} from './provenance';

describe('provenance copy (#3716)', () => {
  it('phrases every scope the same way', () => {
    expect(inheritedFrom(INHERIT_SOURCE.program)).toBe('Inherited from the program default');
    expect(inheritedFrom(INHERIT_SOURCE.workspace)).toBe('Inherited from the workspace default');
    expect(inheritedFrom(INHERIT_SOURCE.system)).toBe('Inherited from the system default');
  });

  it('appends the resolved value in parentheses', () => {
    expect(inheritedFrom(INHERIT_SOURCE.workspace, 'Standard')).toBe(
      'Inherited from the workspace default (Standard)',
    );
  });

  it('builds the colon lead-in and the lowercase aria fragment from the same source', () => {
    expect(inheritedFromLead(INHERIT_SOURCE.programOrWorkspace)).toBe(
      'Inherited from the program or workspace default:',
    );
    expect(inheritedFromPhrase(INHERIT_SOURCE.programOrWorkspace)).toBe(
      'inherited from the program or workspace default',
    );
  });
});
