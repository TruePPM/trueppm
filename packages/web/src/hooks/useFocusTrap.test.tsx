import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useFocusTrap } from './useFocusTrap';

afterEach(cleanup);

function Trap({ active, onEscape }: { active: boolean; onEscape?: () => void }) {
  const ref = useFocusTrap<HTMLDivElement>(active, onEscape);
  return (
    <div>
      <button type="button">outside-before</button>
      <div ref={ref} tabIndex={-1} data-testid="trap">
        <button type="button">first</button>
        <button type="button">last</button>
      </div>
    </div>
  );
}

describe('useFocusTrap', () => {
  it('focuses the first focusable element when activated', () => {
    render(<Trap active />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'first' }));
  });

  it('wraps Tab from the last focusable back to the first', () => {
    render(<Trap active />);
    const last = screen.getByRole('button', { name: 'last' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'first' }));
  });

  it('wraps Shift+Tab from the first focusable to the last', () => {
    render(<Trap active />);
    const first = screen.getByRole('button', { name: 'first' });
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'last' }));
  });

  it('invokes onEscape when Escape is pressed', () => {
    let escaped = false;
    render(<Trap active onEscape={() => (escaped = true)} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(escaped).toBe(true);
  });

  it('does nothing when inactive', () => {
    const before = screen.queryByRole('button', { name: 'outside-before' });
    render(<Trap active={false} />);
    // No focusable was force-focused by the trap.
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'first' }));
    expect(before).toBeNull();
  });
});

/** Multi-state dialog: the phase swap unmounts the previously focused control. */
function PhasedTrap({ active, phase }: { active: boolean; phase: 'one' | 'two' | 'none' }) {
  const ref = useFocusTrap<HTMLDivElement>(active, undefined, phase);
  return (
    <div>
      <button type="button">trigger</button>
      <div ref={ref} tabIndex={-1} data-testid="trap">
        {phase === 'one' && <button type="button">phase-one</button>}
        {phase === 'two' && <button type="button">phase-two</button>}
      </div>
    </div>
  );
}

/** focusKey changes while every control stays mounted. */
function KeyedTrap({ focusKey }: { focusKey: string }) {
  const ref = useFocusTrap<HTMLDivElement>(true, undefined, focusKey);
  return (
    <div ref={ref} tabIndex={-1}>
      <button type="button">first</button>
      <button type="button">second</button>
    </div>
  );
}

describe('useFocusTrap focusKey re-seat (#1776)', () => {
  it('re-seats focus when focusKey changes and the focused control unmounted', () => {
    const { rerender } = render(<PhasedTrap active phase="one" />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'phase-one' }));

    rerender(<PhasedTrap active phase="two" />);
    // phase-one unmounted (focus fell to <body>); the trap re-seats inside.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'phase-two' }));
  });

  it('re-seats from the container fallback onto a control once one appears', () => {
    const { rerender } = render(<PhasedTrap active phase="none" />);
    // No focusables: the container itself is the fallback seat.
    expect(document.activeElement).toBe(screen.getByTestId('trap'));

    rerender(<PhasedTrap active phase="two" />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'phase-two' }));
  });

  it('does not steal focus when focusKey changes but focus is still inside', () => {
    const { rerender } = render(<KeyedTrap focusKey="a" />);
    const second = screen.getByRole('button', { name: 'second' });
    second.focus();

    rerender(<KeyedTrap focusKey="b" />);
    expect(document.activeElement).toBe(second);
  });

  it('restores focus to the activation-time trigger even after focusKey changes', () => {
    const { rerender } = render(<PhasedTrap active={false} phase="one" />);
    const trigger = screen.getByRole('button', { name: 'trigger' });
    trigger.focus();

    rerender(<PhasedTrap active phase="one" />);
    rerender(<PhasedTrap active phase="two" />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'phase-two' }));

    rerender(<PhasedTrap active={false} phase="two" />);
    // Deactivation restores the trigger captured at activation, not an
    // intermediate phase's control.
    expect(document.activeElement).toBe(trigger);
  });
});
