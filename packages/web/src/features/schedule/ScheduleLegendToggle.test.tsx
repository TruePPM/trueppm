import { useRef } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScheduleLegendToggle } from './ScheduleLegendToggle';
import { ScheduleLegend } from './ScheduleLegend';

/** Mirrors how `ScheduleView` wires `legendTriggerRef` between the two (#3614). */
function Wired() {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <ScheduleLegendToggle triggerRef={ref} />
      <ScheduleLegend taskListWidth={240} canLink closeFocusRef={ref} />
    </>
  );
}

describe('ScheduleLegendToggle', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('has the accessible name "Legend"', () => {
    render(<ScheduleLegendToggle />);
    expect(screen.getByRole('button', { name: 'Legend' })).toBeInTheDocument();
  });

  it('is aria-pressed=true on a first visit (legend open by default)', () => {
    render(<ScheduleLegendToggle />);
    expect(screen.getByRole('button', { name: 'Legend' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('clicking toggles aria-pressed, and the accessible name does not change', () => {
    render(<ScheduleLegendToggle />);
    const btn = screen.getByRole('button', { name: 'Legend' });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn).toHaveAccessibleName('Legend');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('drives the SAME state as the legend panel — clicking the toggle shows/hides it (#3614)', () => {
    render(
      <>
        <ScheduleLegendToggle />
        <ScheduleLegend taskListWidth={240} canLink />
      </>,
    );
    expect(screen.getByTestId('schedule-legend')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
    expect(screen.queryByTestId('schedule-legend')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
    expect(screen.getByTestId('schedule-legend')).toBeInTheDocument();
  });

  it('the legend panel’s own close control moves the toolbar button back to aria-pressed=false (#3614)', () => {
    render(
      <>
        <ScheduleLegendToggle />
        <ScheduleLegend taskListWidth={240} canLink />
      </>,
    );
    fireEvent.click(screen.getByTestId('schedule-legend-close'));
    expect(screen.getByRole('button', { name: 'Legend' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.queryByTestId('schedule-legend')).not.toBeInTheDocument();
  });

  it('closing via the panel’s own close control returns focus to the toolbar button, not <body> (#3614)', () => {
    render(<Wired />);
    const close = screen.getByTestId('schedule-legend-close');
    close.focus();
    expect(document.activeElement).toBe(close);

    fireEvent.click(close);
    // `close` is now unmounted (the panel returned null) — focus must have
    // moved to the control that can reopen it, matching the how-to bar's
    // `displayTriggerRef` pattern (#3134), never fallen through to <body>.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Legend' }));
  });
});
