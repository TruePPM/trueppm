import { describe, expect, it, vi } from 'vitest';
import { formatChord } from '@/lib/platform';
import { render, screen, fireEvent } from '@testing-library/react';
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
    expect(
      screen.getByRole('button', { name: 'Add new phase (Option+Cmd+P)' }),
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
