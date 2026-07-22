import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { resolveActiveSection, useScrollSpy } from './useScrollSpy';

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

describe('useScrollSpy at-bottom guard (#2252)', () => {
  const sectionIds = ['general', 'email', 'danger'];

  /**
   * Build a scroll container whose section geometry is fixed so `recompute`'s
   * getBoundingClientRect reads are deterministic. `danger` (the last section)
   * sits well below the sentinel line — its top never crosses — so only the
   * at-bottom override can activate it. `scrollMetrics` decides at-bottom.
   */
  function makeContainer(scrollMetrics: {
    scrollHeight: number;
    scrollTop: number;
    clientHeight: number;
  }) {
    const container = document.createElement('div');
    // Section tops (viewport px): general above the line, email just above it,
    // danger far below it (never crosses the sentinel and can't scroll further).
    const sectionTop: Record<string, number> = { general: -500, email: 50, danger: 700 };
    for (const id of sectionIds) {
      const el = document.createElement('div');
      el.setAttribute('data-settings-section', id);
      el.getBoundingClientRect = () => ({ top: sectionTop[id] }) as DOMRect;
      container.appendChild(el);
    }
    container.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    for (const [k, v] of Object.entries(scrollMetrics)) {
      Object.defineProperty(container, k, { value: v, configurable: true });
    }
    document.body.appendChild(container);
    return container;
  }

  it('forces the last section active when scrolled to the bottom', () => {
    // scrollHeight - scrollTop - clientHeight === 0 → at bottom.
    const container = makeContainer({ scrollHeight: 1000, scrollTop: 200, clientHeight: 800 });
    const { result } = renderHook(() =>
      useScrollSpy({ sectionIds, scrollRef: { current: container } }),
    );
    // `danger`'s top never crossed the sentinel, so without the guard this would
    // be stuck on `email`; the at-bottom override lifts it to `danger`.
    expect(result.current.activeId).toBe('danger');
  });

  it('does not force the last section when not at the bottom', () => {
    // 1000 - 100 - 800 === 100 (> 2px) → not at bottom.
    const container = makeContainer({ scrollHeight: 1000, scrollTop: 100, clientHeight: 800 });
    const { result } = renderHook(() =>
      useScrollSpy({ sectionIds, scrollRef: { current: container } }),
    );
    expect(result.current.activeId).toBe('email');
  });
});
