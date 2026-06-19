import { describe, expect, it } from 'vitest';
import { resolveActiveSection } from './useScrollSpy';

describe('resolveActiveSection (ADR-0146, #1248)', () => {
  const order = ['general', 'access', 'methodology', 'lifecycle'];

  it('returns null for an empty order', () => {
    expect(resolveActiveSection({}, [])).toBeNull();
  });

  it('activates the first section when nothing has crossed the line', () => {
    // Page at the very top — every section is below the sentinel (positive top).
    const tops = { general: 0, access: 400, methodology: 800, lifecycle: 1200 };
    expect(resolveActiveSection(tops, order)).toBe('general');
  });

  it('activates the LAST section whose top has scrolled past the line', () => {
    // Scrolled so general + access are above the line, methodology just below.
    const tops = { general: -500, access: -50, methodology: 120, lifecycle: 900 };
    expect(resolveActiveSection(tops, order)).toBe('access');
  });

  it('treats a section exactly on the line as active (top === 0)', () => {
    const tops = { general: -200, access: 0, methodology: 300, lifecycle: 900 };
    expect(resolveActiveSection(tops, order)).toBe('access');
  });

  it('activates the final section once it crosses the line', () => {
    const tops = { general: -900, access: -600, methodology: -300, lifecycle: -10 };
    expect(resolveActiveSection(tops, order)).toBe('lifecycle');
  });

  it('does not skip past a still-below section (breaks at the first positive top)', () => {
    // access is below the line even though methodology happens to be above it —
    // document order governs; we stop at the first not-yet-crossed section.
    const tops = { general: -100, access: 50, methodology: -10, lifecycle: 900 };
    expect(resolveActiveSection(tops, order)).toBe('general');
  });

  it('skips unmeasured sections (continue) and keeps scanning later measured ones', () => {
    // access has no measurement; the scan continues to methodology, which has
    // crossed the line, so it wins. Unmeasured entries never reset the active id.
    const tops = { general: -100, methodology: -20 };
    expect(resolveActiveSection(tops, order)).toBe('methodology');
  });

  it('keeps the first section active when only later sections are measured but below', () => {
    const tops = { general: 10, access: 500 };
    expect(resolveActiveSection(tops, order)).toBe('general');
  });
});
