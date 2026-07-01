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

  it('shows no label at sm/md even when showLabel is set (no room)', () => {
    const sm = renderSquare({ program: SET, size: 'sm', showLabel: true });
    expect(sm).toHaveTextContent('');
    expect(sm.className).toContain('h-2.5');
    const md = renderSquare({ program: SET, size: 'md', showLabel: true });
    expect(md).toHaveTextContent('');
    expect(md.className).toContain('h-4');
  });

  describe('xs-label dense-list variant (issue 1051)', () => {
    it('labels an unset-color tile with 1–2-char name initials so uncolored programs are distinguishable', () => {
      const el = renderSquare({ program: UNSET, size: 'xs-label' });
      // Still the faint neutral FILLED square (no accent), but now carrying the
      // initials — "Phase 2 Modernization" → "P2".
      expect(el.className).toContain('bg-neutral-surface-sunken');
      expect(el.className).toContain('h-4');
      expect(el.className).toContain('text-[7px]');
      expect(el.style.backgroundColor).toBe('');
      expect(el).toHaveTextContent('P2');
    });

    it('labels a single-word unset program with its first two letters', () => {
      const el = renderSquare({
        program: { color: null, code: '', name: 'Atlas' },
        size: 'xs-label',
      });
      expect(el).toHaveTextContent('AT');
    });

    it('renders the code on the accent fill when color is set', () => {
      const el = renderSquare({ program: SET, size: 'xs-label' });
      expect(el).toHaveStyle({ backgroundColor: '#7C3AED' });
      expect(el).toHaveTextContent('PHX');
      expect(el.className).not.toContain('bg-neutral-surface-sunken');
    });

    it('always carries the label — showLabel is a no-op for this variant', () => {
      // Unlike lg, xs-label needs no showLabel to render initials.
      const el = renderSquare({ program: UNSET, size: 'xs-label' });
      expect(el).toHaveTextContent('P2');
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
