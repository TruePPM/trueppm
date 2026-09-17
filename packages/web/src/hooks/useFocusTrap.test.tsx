import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { getFocusable, useFocusTrap } from './useFocusTrap';

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
 * A roving-tabindex group inside the trap (#3208).
 *
 * `roving-before` and `roving-after` are native `<button>`s carrying
 * `tabIndex={-1}` — the shape every non-selected option in a roving group has
 * (web rule 167). The browser's tab order cannot reach either of them, so the
 * trap's real `first` is `real-first` and its real `last` is `real-last`.
 *
 * They deliberately bracket the real stops on both sides, because the two
 * shipped instances of this bug sat on opposite ends: CommandPalette's option
 * rows trailed the dialog (breaking forward-Tab) and the dependency picker's
 * ScopeTabs led it (breaking Shift+Tab).
 */
function RovingTrap() {
  const ref = useFocusTrap<HTMLDivElement>(true);
  return (
    <div ref={ref} tabIndex={-1} data-testid="trap">
      <button type="button" role="tab" tabIndex={-1}>
        roving-before
      </button>
      <button type="button">real-first</button>
      <button type="button">real-last</button>
      <button type="button" role="option" aria-selected={false} tabIndex={-1}>
        roving-after
      </button>
    </div>
  );
}

describe('useFocusTrap roving-tabindex members are not tab stops (#3208)', () => {
  const btn = (name: string) => screen.getByRole('button', { name });

  it('excludes native focusables carrying tabIndex={-1} from getFocusable', () => {
    render(<RovingTrap />);
    expect(getFocusable(screen.getByTestId('trap')).map((el) => el.textContent)).toEqual([
      'real-first',
      'real-last',
    ]);
  });

  it('seats initial focus on the first real tab stop, not the roving member before it', () => {
    render(<RovingTrap />);
    expect(document.activeElement).toBe(btn('real-first'));
  });

  // The load-bearing assertion. A forward-Tab-only check passes on the broken
  // selector whenever the roving members trail the dialog, which is why the
  // CommandPalette regression shipped — tab BACKWARDS from the first real stop.
  it('wraps Shift+Tab from the first real tab stop even with a roving member before it', () => {
    render(<RovingTrap />);
    btn('real-first').focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(btn('real-last'));
  });

  it('wraps Tab from the last real tab stop even with a roving member after it', () => {
    render(<RovingTrap />);
    btn('real-last').focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(btn('real-first'));
  });
});

/** Disabled fields are not tab stops either — two copies had dropped this. */
function DisabledTrap() {
  const ref = useFocusTrap<HTMLDivElement>(true);
  return (
    <div ref={ref} tabIndex={-1} data-testid="trap">
      <button type="button">go</button>
      <input disabled aria-label="disabled-input" />
      <textarea disabled aria-label="disabled-textarea" />
      <select disabled aria-label="disabled-select" />
    </div>
  );
}

describe('useFocusTrap excludes disabled fields (#3208)', () => {
  // `MonteCarloDetailPanel` and `AgentActionDrawer` had drifted to bare
  // `textarea, input, select`; `ScheduleExportDialog` had dropped both entirely.
  // Both directions of that drift are gone now that the selector has one home.
  it('omits disabled input, textarea and select', () => {
    render(<DisabledTrap />);
    expect(getFocusable(screen.getByTestId('trap'))).toEqual([
      screen.getByRole('button', { name: 'go' }),
    ]);
  });
});
