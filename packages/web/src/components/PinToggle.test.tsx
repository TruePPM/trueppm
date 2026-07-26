/**
 * Shared pin toggle (#2390, ADR-0627).
 *
 * Most of what matters here is accessibility and reachability: the control is
 * hover-revealed at its default `reveal="auto"`, which is exactly the pattern
 * that strands touch and keyboard users when it is done by `:hover` alone.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PinToggle, type PinToggleSize } from './PinToggle';

const mutate = vi.fn();
vi.mock('@/hooks/usePins', () => ({
  useTogglePin: () => ({ mutate, isPending: false }),
}));
vi.mock('@/components/Toast', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

import { toast } from '@/components/Toast';

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

function setOffline() {
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
}

describe('PinToggle — labeling', () => {
  it('names the action AND the target, flipping with state', () => {
    const { rerender } = render(<PinToggle kind="project" id="p1" name="Alpha" pinned={false} />);
    expect(screen.getByRole('button', { name: 'Pin Alpha' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    rerender(<PinToggle kind="project" id="p1" name="Alpha" pinned />);
    expect(screen.getByRole('button', { name: 'Unpin Alpha' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('PinToggle — reveal is a pointer capability, not a breakpoint', () => {
  it('renders at 60% on a coarse pointer, where :hover never fires', () => {
    // The bug this replaces was `md:`-gated: a tablet is wider than `md` and
    // still cannot hover, so an unpinned toggle sat at opacity-0 and a FIRST pin
    // could not be created there at all.
    render(<PinToggle kind="project" id="p1" name="Alpha" pinned={false} />);
    const btn = screen.getByRole('button', { name: 'Pin Alpha' });
    expect(btn).toHaveClass('[@media(hover:none)]:opacity-60');
    expect(btn).toHaveClass('[@media(pointer:coarse)]:opacity-60');
    // Never display:none — the control keeps its box, tab order, and SR presence.
    expect(btn).not.toHaveClass('hidden');
  });

  it('becomes visible on keyboard focus regardless of hover', () => {
    render(<PinToggle kind="project" id="p1" name="Alpha" pinned={false} />);
    // `focus:` not `focus-visible:` — focus-visible withholds the cue on
    // pointer-driven focus in Firefox and desktop Safari.
    expect(screen.getByRole('button', { name: 'Pin Alpha' })).toHaveClass('focus:opacity-100');
  });

  it('keeps a PINNED toggle at full strength — a pin you cannot see cannot be undone', () => {
    render(<PinToggle kind="project" id="p1" name="Alpha" pinned />);
    const btn = screen.getByRole('button', { name: 'Unpin Alpha' });
    expect(btn).toHaveClass('opacity-100');
    expect(btn).not.toHaveClass('opacity-0');
  });

  it('never hides when reveal="always" — a header has no row to hover', () => {
    render(<PinToggle kind="program" id="g1" name="Apollo" pinned={false} reveal="always" />);
    const btn = screen.getByRole('button', { name: 'Pin Apollo' });
    expect(btn).toHaveClass('opacity-100');
    expect(btn).not.toHaveClass('opacity-0');
  });

  it('rings inset, so a 44px control inside a 36px row never clips its focus ring', () => {
    render(<PinToggle kind="project" id="p1" name="Alpha" pinned={false} />);
    expect(screen.getByRole('button', { name: 'Pin Alpha' })).toHaveClass('focus:ring-inset');
  });
});

describe('PinToggle — 44px hit area at every size', () => {
  it.each<[PinToggleSize, string[]]>([
    // `sm` paints a 36px plate but restores the target with a 4px pseudo-element
    // bleed on each edge (36 + 8 = 44). `min-w` would have reflowed the row.
    ['sm', ['h-9', 'w-9', "before:absolute", 'before:inset-[-4px]']],
    ['md', ['h-11', 'w-11']],
    ['lg', ['h-11', 'w-11']],
  ])('size=%s', (size, classes) => {
    render(<PinToggle kind="project" id="p1" name="Alpha" pinned={false} size={size} />);
    expect(screen.getByRole('button', { name: 'Pin Alpha' })).toHaveClass(...classes);
  });
});

describe('PinToggle — interaction', () => {
  it('sends the target state, not a bare toggle', () => {
    render(<PinToggle kind="project" id="p1" name="Alpha" pinned={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pin Alpha' }));
    expect(mutate).toHaveBeenCalledWith(
      { kind: 'project', id: 'p1', name: 'Alpha', next: true, onResort: undefined },
      expect.anything(),
    );
  });

  it('forwards a re-sort callback so a grouped list can offer the deferred move', () => {
    const onResort = vi.fn();
    render(<PinToggle kind="project" id="p1" name="Alpha" pinned={false} onResort={onResort} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pin Alpha' }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ onResort }),
      expect.anything(),
    );
  });

  it('does not navigate the row or card it sits inside', () => {
    const onNavigate = vi.fn();
    render(
      <a href="/somewhere" onClick={onNavigate}>
        <span>Alpha</span>
        <PinToggle kind="project" id="p1" name="Alpha" pinned={false} />
      </a>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pin Alpha' }));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalled();
  });

  it('explains itself when offline instead of failing silently', () => {
    setOffline();
    render(<PinToggle kind="project" id="p1" name="Alpha" pinned={false} />);
    const btn = screen.getByRole('button', { name: 'Pin Alpha' });
    // aria-disabled, not `disabled`: a disabled button leaves the tab order and
    // can no longer tell anyone why it is inert.
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).not.toBeDisabled();

    fireEvent.click(btn);
    expect(mutate).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("You're offline — pins can't be changed right now.");
  });
});

describe('PinToggle — motion', () => {
  // Separate renders, not a rerender: each click arms the ~200ms in-flight
  // lockout, and the mocked `mutate` never settles it, so a second click on the
  // same instance would be swallowed and prove nothing.
  it('pops when a pin is created', () => {
    render(<PinToggle kind="project" id="p1" name="Alpha" pinned={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pin Alpha' }));
    expect(screen.getByRole('button').querySelector('svg')).toHaveClass(
      'motion-safe:animate-pin-pop',
    );
  });

  it('does not pop on unpin — removing a thing should not draw the eye back', () => {
    render(<PinToggle kind="project" id="p2" name="Beta" pinned />);
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Beta' }));
    expect(screen.getByRole('button').querySelector('svg')).not.toHaveClass(
      'motion-safe:animate-pin-pop',
    );
  });
});

describe('PinToggle — the pinned pin is not a status', () => {
  it('uses neutral ink, never a reserved health hue', () => {
    render(<PinToggle kind="project" id="p1" name="Alpha" pinned reveal="always" />);
    const glyph = screen.getByRole('button', { name: 'Unpin Alpha' }).querySelector('svg');
    // `--brand-primary` and `--semantic-on-track` are the SAME token value here,
    // so a brand-filled pin would render in exactly the "On track" hue — beside
    // the health chip on the project header, and beside the health dot on every
    // rail row. A pin is not a status. (ADR-0627 §D12.)
    expect(glyph).not.toHaveClass('text-semantic-on-track');
    expect(glyph).not.toHaveClass('text-semantic-at-risk');
    expect(glyph).not.toHaveClass('text-brand-primary');
    expect(glyph).toHaveClass('text-neutral-text-primary');
  });

  it('carries state in shape as well as ink, for a monochrome viewer', () => {
    const { rerender } = render(
      <PinToggle kind="project" id="p1" name="Alpha" pinned={false} reveal="always" />,
    );
    // Unpinned is an outline: stroked path, no fill.
    const outline = screen.getByRole('button').querySelector('svg path');
    expect(outline).toHaveAttribute('fill', 'none');
    expect(outline).toHaveAttribute('stroke', 'currentColor');

    rerender(<PinToggle kind="project" id="p1" name="Alpha" pinned reveal="always" />);
    // Pinned is solid, with the hole knocked out via evenodd rather than painted
    // in a background color that would have to be kept in sync with every plate.
    const solid = screen.getByRole('button').querySelector('svg path');
    expect(solid).toHaveAttribute('fill', 'currentColor');
    expect(solid).toHaveAttribute('fill-rule', 'evenodd');
  });
});
