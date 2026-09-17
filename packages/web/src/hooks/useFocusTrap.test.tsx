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

/**
 * Rule 362: an in-flight flag disables every control WITHOUT unmounting it.
 *
 * `keyed` selects between the fixed shape (pending passed as `focusKey`) and the
 * bug (no third argument), so the second test below is the negative control
 * applied rather than asserted.
 *
 * WHAT THIS CAN AND CANNOT PIN. jsdom does not blur a focused element when it is
 * disabled, so the browser step that actually starts the bug does not happen
 * here — which is why rule 362 calls a naive "focus stayed inside the trap"
 * assertion vacuous by construction, and why the browser-level proof lives in
 * `e2e/baseline-manage.spec.ts`. These tests model that step explicitly with
 * `.blur()` and then pin the half a unit test CAN own: given focus has left the
 * container, a changed `focusKey` re-seats it and an absent one does not.
 */
function PendingTrap({ pending, keyed }: { pending: boolean; keyed: boolean }) {
  const ref = useFocusTrap<HTMLDivElement>(true, undefined, keyed ? pending : undefined);
  return (
    <div>
      <button type="button">outside</button>
      <div ref={ref} tabIndex={-1} data-testid="trap">
        <button type="button" disabled={pending}>
          cancel
        </button>
        <button type="button" disabled={pending}>
          confirm
        </button>
      </div>
    </div>
  );
}

describe('useFocusTrap empty-phase seat (web rule 362, #3352)', () => {
  it('seats focus on the container when the pending flag disables every control', () => {
    const { rerender } = render(<PendingTrap pending={false} keyed />);
    const confirm = screen.getByRole('button', { name: 'confirm' });
    confirm.focus();

    // The browser blurs a control the moment it is disabled; jsdom does not, so
    // the step is performed explicitly here. Everything after it is the hook's.
    confirm.blur();
    rerender(<PendingTrap pending keyed />);

    // Nothing inside is focusable any more, so the container is the seat — and
    // focus is inside the aria-modal surface rather than on <body>.
    expect(document.activeElement).toBe(screen.getByTestId('trap'));
  });

  it('re-seats onto the safe control once the request settles and re-enables it', () => {
    const { rerender } = render(<PendingTrap pending={false} keyed />);
    screen.getByRole('button', { name: 'confirm' }).focus();
    screen.getByRole('button', { name: 'confirm' }).blur();
    rerender(<PendingTrap pending keyed />);
    expect(document.activeElement).toBe(screen.getByTestId('trap'));

    // Error path: the dialog stays open and the controls come back.
    rerender(<PendingTrap pending={false} keyed />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'cancel' }));
  });

  it('NEGATIVE CONTROL — without the focusKey, focus is left on <body>', () => {
    const { rerender } = render(<PendingTrap pending={false} keyed={false} />);
    const confirm = screen.getByRole('button', { name: 'confirm' });
    confirm.focus();

    confirm.blur();
    rerender(<PendingTrap pending keyed={false} />);

    // The seat effect never re-runs, so focus stays outside the trap: from here
    // `document.activeElement` is neither the first nor the last focusable, the
    // Tab handler stops intercepting, and Tab leaves the modal.
    expect(document.activeElement).toBe(document.body);
    expect(document.activeElement).not.toBe(screen.getByTestId('trap'));
  });
});

/**
 * Two traps at once: a global gate (the session-expired modal) opening on top of
 * a write dialog whose in-flight flag is its `focusKey`.
 */
function StackedModals({ pending, gate }: { pending: boolean; gate: boolean }) {
  const dialogRef = useFocusTrap<HTMLDivElement>(true, undefined, pending);
  const gateRef = useFocusTrap<HTMLDivElement>(gate);
  return (
    <div>
      <div ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1} data-testid="dialog">
        <button type="button" disabled={pending}>
          dialog-cancel
        </button>
        <button type="button" disabled={pending}>
          dialog-save
        </button>
      </div>
      {gate && (
        <div ref={gateRef} role="dialog" aria-modal="true" tabIndex={-1} data-testid="gate">
          <button type="button">sign-in</button>
        </div>
      )}
    </div>
  );
}

describe('useFocusTrap stacked modals (#3352)', () => {
  it('a focusKey re-seat stands down while a modal above owns focus', () => {
    const { rerender } = render(<StackedModals pending gate={false} />);
    // The gate opens on top and takes focus (its activation seat is exempt from
    // the stand-down — it is the new surface asking for focus).
    rerender(<StackedModals pending gate />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'sign-in' }));

    // The write below settles: its focusKey changes, and it must NOT drag focus
    // back out of the gate — that is WCAG 2.4.3 in reverse.
    rerender(<StackedModals pending={false} gate />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'sign-in' }));
  });

  it('still re-seats when no other modal holds focus', () => {
    const { rerender } = render(<StackedModals pending={false} gate={false} />);
    const save = screen.getByRole('button', { name: 'dialog-save' });
    save.focus();
    save.blur();

    rerender(<StackedModals pending gate={false} />);
    expect(document.activeElement).toBe(screen.getByTestId('dialog'));
  });
});
