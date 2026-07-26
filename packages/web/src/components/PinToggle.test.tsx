/**
 * Shared pin toggle (#2390, ADR-0627).
 *
 * Most of what matters here is accessibility and reachability: the control is
 * hover-revealed on two of its three placements, which is exactly the pattern
 * that strands touch and keyboard users when it is done by `:hover` alone.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PinToggle } from './PinToggle';

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
    const { rerender } = render(
      <PinToggle kind="project" id="p1" name="Alpha" pinned={false} placement="row" />,
    );
    expect(screen.getByRole('button', { name: 'Pin Alpha' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    rerender(<PinToggle kind="project" id="p1" name="Alpha" pinned placement="row" />);
    expect(screen.getByRole('button', { name: 'Unpin Alpha' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('PinToggle — reachability', () => {
  it('is visible on touch viewports, where :hover never fires', () => {
    // Without `max-md:opacity-100` an unpinned toggle is invisible AND
    // untappable on a phone — the control would simply not exist for touch.
    render(<PinToggle kind="project" id="p1" name="Alpha" pinned={false} placement="row" />);
    expect(screen.getByRole('button', { name: 'Pin Alpha' })).toHaveClass('max-md:opacity-100');
  });

  it('becomes visible on keyboard focus', () => {
    render(<PinToggle kind="project" id="p1" name="Alpha" pinned={false} placement="row" />);
    // `focus:` not `focus-visible:` — focus-visible withholds the cue on
    // pointer-driven focus in Firefox and desktop Safari.
    expect(screen.getByRole('button', { name: 'Pin Alpha' })).toHaveClass('focus:opacity-100');
  });

  it('keeps the header placement always visible — a header has no row to hover', () => {
    render(<PinToggle kind="program" id="g1" name="Apollo" pinned={false} placement="header" />);
    expect(screen.getByRole('button', { name: 'Pin Apollo' })).not.toHaveClass('opacity-0');
  });

  it('meets the 44px touch minimum on every placement', () => {
    for (const placement of ['rail', 'row', 'header'] as const) {
      const { unmount } = render(
        <PinToggle kind="project" id="p1" name="Alpha" pinned={false} placement={placement} />,
      );
      expect(screen.getByRole('button', { name: 'Pin Alpha' })).toHaveClass('h-11', 'w-11');
      unmount();
    }
  });
});

describe('PinToggle — interaction', () => {
  it('sends the target state, not a bare toggle', () => {
    render(<PinToggle kind="project" id="p1" name="Alpha" pinned={false} placement="row" />);
    fireEvent.click(screen.getByRole('button', { name: 'Pin Alpha' }));
    expect(mutate).toHaveBeenCalledWith(
      { kind: 'project', id: 'p1', name: 'Alpha', next: true },
      expect.anything(),
    );
  });

  it('does not navigate the row or card it sits inside', () => {
    const onNavigate = vi.fn();
    render(
      <a href="/somewhere" onClick={onNavigate}>
        <span>Alpha</span>
        <PinToggle kind="project" id="p1" name="Alpha" pinned={false} placement="row" />
      </a>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pin Alpha' }));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalled();
  });

  it('explains itself when offline instead of failing silently', () => {
    setOffline();
    render(<PinToggle kind="project" id="p1" name="Alpha" pinned={false} placement="row" />);
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

describe('PinToggle — the pinned star is not a status', () => {
  it('uses neutral ink, never the reserved amber health hue', () => {
    render(<PinToggle kind="project" id="p1" name="Alpha" pinned placement="header" />);
    const glyph = screen.getByRole('button', { name: 'Unpin Alpha' }).querySelector('svg');
    // On the Project Overview header a filled amber star would sit a few hundred
    // pixels from an amber "At risk" chip and read as a health signal.
    expect(glyph).not.toHaveClass('text-semantic-at-risk');
    expect(glyph).toHaveClass('text-neutral-text-primary');
  });

  it('carries state in shape as well as ink, for a monochrome viewer', () => {
    const { rerender } = render(
      <PinToggle kind="project" id="p1" name="Alpha" pinned={false} placement="header" />,
    );
    expect(screen.getByRole('button').querySelector('svg')).toHaveAttribute('fill', 'none');

    rerender(<PinToggle kind="project" id="p1" name="Alpha" pinned placement="header" />);
    expect(screen.getByRole('button').querySelector('svg')).toHaveAttribute('fill', 'currentColor');
  });
});
