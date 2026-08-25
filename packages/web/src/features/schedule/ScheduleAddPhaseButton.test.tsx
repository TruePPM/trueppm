import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { formatChord } from '@/lib/platform';
import { ScheduleAddPhaseButton } from './ScheduleAddPhaseButton';

describe('ScheduleAddPhaseButton', () => {
  it('renders with the summary-bracket glyph and label', () => {
    render(<ScheduleAddPhaseButton onAddPhase={vi.fn()} />);
    expect(screen.getByTestId('add-phase-button')).toBeInTheDocument();
    expect(screen.getByText('+ Phase')).toBeInTheDocument();
  });

  it('stays a fixed size in the flex-nowrap toolbar (no zoom reflow, matches issue 1632 guard)', () => {
    render(<ScheduleAddPhaseButton onAddPhase={vi.fn()} />);
    const btn = screen.getByTestId('add-phase-button');
    expect(btn.className).toMatch(/\bshrink-0\b/);
    expect(btn.className).toMatch(/\bwhitespace-nowrap\b/);
  });

  it('uses the brand-primary family, never gold (gold is reserved for milestone)', () => {
    render(<ScheduleAddPhaseButton onAddPhase={vi.fn()} />);
    const btn = screen.getByTestId('add-phase-button');
    expect(btn.className).toMatch(/brand-primary/);
    expect(btn.className).not.toMatch(/brand-accent/);
  });

  it('exposes a hotkey-aware accessible label', () => {
    render(<ScheduleAddPhaseButton onAddPhase={vi.fn()} />);
    // The accessible name and the tooltip are now ONE derived string (#2951). Two
    // pre-existing defects went with the split. They said different things — the
    // tooltip "with its first task", the accessible name not — so a screen-reader user
    // was told strictly less about what the press would do. And the accessible name
    // HARDCODED the Mac chord, announcing "Option+Cmd+P" to a Windows or Linux user
    // while the tooltip beside it correctly read "Ctrl+Alt+P" (rule 326 / #3028).
    //
    // Derived from `formatChord`, never restated: a literal here rots exactly the way
    // the hardcoded label did, and would pass on whichever platform CI happens to run.
    expect(
      screen.getByRole('button', {
        name: `Add new phase, with its first task (${formatChord('mod+alt+p')})`,
      }),
    ).toBeInTheDocument();
  });

  it('clicking calls onAddPhase', () => {
    const onAdd = vi.fn();
    render(<ScheduleAddPhaseButton onAddPhase={onAdd} />);
    fireEvent.click(screen.getByTestId('add-phase-button'));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('disabled prop blocks the click handler', () => {
    const onAdd = vi.fn();
    render(<ScheduleAddPhaseButton onAddPhase={onAdd} disabled />);
    fireEvent.click(screen.getByTestId('add-phase-button'));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('disabled state shows the read-only tooltip', () => {
    render(<ScheduleAddPhaseButton onAddPhase={vi.fn()} disabled />);
    expect(screen.getByTestId('add-phase-button')).toHaveAttribute('title', 'Read-only access');
  });

  it('tells a pointer user the button now brings a task with it (#2955)', () => {
    // The only surface that states the changed behavior to somebody who never opens the
    // cheatsheet — the accessible name carries the chord, the title carries the outcome.
    render(<ScheduleAddPhaseButton onAddPhase={vi.fn()} />);
    expect(screen.getByTestId('add-phase-button')).toHaveAttribute(
      'title',
      `Add new phase, with its first task (${formatChord('mod+alt+p')})`,
    );
  });

  it('pending state blocks the click and shows wait cursor', () => {
    const onAdd = vi.fn();
    render(<ScheduleAddPhaseButton onAddPhase={onAdd} pending />);
    const btn = screen.getByTestId('add-phase-button');
    fireEvent.click(btn);
    expect(onAdd).not.toHaveBeenCalled();
    expect(btn.className).toMatch(/cursor-wait/);
  });
});

describe('ScheduleAddPhaseButton — the control states which act it performs (#2951)', () => {
  it('names the row it would adopt, in both the accessible name and the tooltip', () => {
    render(<ScheduleAddPhaseButton onAddPhase={vi.fn()} adoptsRowName="Mobilization" />);
    const btn = screen.getByTestId('add-phase-button');
    // Derived once and used for both, so the two can never describe different acts.
    expect(btn).toHaveAccessibleName(/Make Mobilization a phase, with a task inside it/);
    expect(btn.getAttribute('title')).toMatch(/Make Mobilization a phase, with a task inside it/);
  });

  it('falls back to the new-phase wording when there is nothing to adopt', () => {
    render(<ScheduleAddPhaseButton onAddPhase={vi.fn()} />);
    const btn = screen.getByTestId('add-phase-button');
    expect(btn).toHaveAccessibleName(/Add new phase, with its first task/);
    // The two acts must not read the same — a label that did not change would be a
    // claim about a write the user is about to make to a row it never mentions.
    expect(btn).not.toHaveAccessibleName(/Make .* a phase/);
  });

  it('keeps the read-only tooltip regardless of what is focused', () => {
    render(<ScheduleAddPhaseButton onAddPhase={vi.fn()} disabled adoptsRowName="Mobilization" />);
    expect(screen.getByTestId('add-phase-button').getAttribute('title')).toBe('Read-only access');
  });
});
