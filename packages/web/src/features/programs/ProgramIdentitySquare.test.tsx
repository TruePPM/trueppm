import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ProgramIdentitySquare } from './ProgramIdentitySquare';

const SET = { color: '#7C3AED', code: 'PHX', name: 'Phoenix Rollout' };
const UNSET = { color: null, code: '', name: 'Phase 2 Modernization' };

function renderSquare(props: Parameters<typeof ProgramIdentitySquare>[0]) {
  const { container } = render(<ProgramIdentitySquare {...props} />);
  return container.firstElementChild as HTMLElement;
}

describe('ProgramIdentitySquare (#963)', () => {
  it('fills with the accent color and an AA-contrast label when color is set', () => {
    const el = renderSquare({ program: SET, size: 'lg', showLabel: true });
    // Dynamic accent applies via the style prop (no hex class). #7C3AED is dark
    // → contrastText resolves to white.
    expect(el).toHaveStyle({ backgroundColor: '#7C3AED' });
    expect(el).toHaveStyle({ color: '#FFFFFF' });
    expect(el).toHaveTextContent('PHX');
    // No neutral fallback class when an accent is set.
    expect(el.className).not.toContain('bg-neutral-surface-sunken');
  });

  it('is a faint neutral FILLED square when color is unset — never health-tinted', () => {
    const el = renderSquare({ program: UNSET, size: 'lg', showLabel: true });
    expect(el.className).toContain('bg-neutral-surface-sunken');
    expect(el.className).toContain('text-neutral-text-secondary');
    // No inline accent and no semantic/health classes leak into the identity tile.
    expect(el.style.backgroundColor).toBe('');
    expect(el.className).not.toMatch(/semantic-(on-track|at-risk|critical)/);
    // Unset still labels from name initials at lg: "Phase 2 Modernization" → "P2".
    expect(el).toHaveTextContent('P2');
  });

  it('renders the code (sliced to 3) in preference to name initials', () => {
    const el = renderSquare({
      program: { color: null, code: 'ARTM', name: 'Artemis Program' },
      size: 'lg',
      showLabel: true,
    });
    expect(el).toHaveTextContent('ART');
  });

  it('labels a single-word unset program with its first two letters', () => {
    const el = renderSquare({
      program: { color: null, code: '', name: 'Atlas' },
      size: 'lg',
      showLabel: true,
    });
    expect(el).toHaveTextContent('AT');
  });

  it('shows no label at sm/md even when showLabel is set (no room)', () => {
    const sm = renderSquare({ program: SET, size: 'sm', showLabel: true });
    expect(sm).toHaveTextContent('');
    expect(sm.className).toContain('h-2.5');
    const md = renderSquare({ program: SET, size: 'md', showLabel: true });
    expect(md).toHaveTextContent('');
    expect(md.className).toContain('h-4');
  });

  // The `xs-label` variant is GONE (#3475). It rendered `text-[7px]` initials in a
  // 16px tile — below the rule-50 floor in every tree, settings included — and the
  // two call sites that used it (the rail's pinned programs and its Browse switcher
  // list) both render the program NAME as adjacent text, so the glyphs were never
  // the distinguishing signal issue 1051 added them to be. These tests pin the
  // absence: a size that cannot hold legible type carries none, and no tile emits a
  // sub-floor `text-[Npx]` class at any size.
  describe('no sub-floor type at any size (#3475, rule 50)', () => {
    const SIZES = ['sm', 'md', 'lg'] as const;

    it.each(SIZES)('renders no sub-floor text-[Npx] class at %s', (size) => {
      const el = renderSquare({ program: SET, size, showLabel: true });
      // Anything below 12px, fractions included — the same shape the CI gate's
      // TINY_TEXT_PAT matches, so this test and the gate agree by construction.
      expect(el.className).not.toMatch(/text-\[(1[01]|[0-9])(\.\d+)?px\]/);
    });

    it('md is a label-free dot even for an unset-color program', () => {
      // The dense-rail case issue 1051 was filed about. The tile stays the faint
      // neutral FILLED square; distinguishing the program is the adjacent name's
      // job, not two guessed-at 7px glyphs.
      const el = renderSquare({ program: UNSET, size: 'md' });
      expect(el.className).toContain('bg-neutral-surface-sunken');
      expect(el.className).toContain('h-4');
      expect(el.style.backgroundColor).toBe('');
      expect(el).toHaveTextContent('');
    });

    it('md keeps the accent fill and still shows no label', () => {
      const el = renderSquare({ program: SET, size: 'md' });
      expect(el).toHaveStyle({ backgroundColor: '#7C3AED' });
      expect(el).toHaveTextContent('');
      expect(el.className).not.toContain('bg-neutral-surface-sunken');
    });

    it('lg — the only labeled size — is at the text-xs floor', () => {
      const el = renderSquare({ program: SET, size: 'lg', showLabel: true });
      expect(el.className).toContain('text-xs');
      expect(el).toHaveTextContent('PHX');
    });
  });

  it('is always aria-hidden (the marker is decorative; the name is the signal)', () => {
    const el = renderSquare({ program: SET, size: 'sm' });
    expect(el).toHaveAttribute('aria-hidden', 'true');
  });

  it('merges a dimension override without dropping the accent', () => {
    const el = renderSquare({ program: SET, size: 'lg', showLabel: true, className: 'h-10 w-10' });
    expect(el.className).toContain('h-10');
    expect(el.className).toContain('w-10');
    expect(el).toHaveStyle({ backgroundColor: '#7C3AED' });
  });
});
