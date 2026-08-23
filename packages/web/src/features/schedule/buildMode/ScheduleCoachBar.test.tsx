import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { ScheduleCoachBar } from './ScheduleCoachBar';

describe('ScheduleCoachBar', () => {
  afterEach(cleanup);

  it('teaches the gesture a static screen cannot show', () => {
    render(<ScheduleCoachBar onDismiss={() => {}} onShowCheatsheet={() => {}} />);
    // The row controls only appear on hover, so nothing else can announce them.
    expect(screen.getByText('+ ⇤ ⇥ ◆')).toBeInTheDocument();
    // #3020: the indent chip names ⌥→, the key that is actually bound. It
    // shipped as ⇥, and Tab is bound to nothing on purpose — binding it
    // reproduces the WCAG 2.1.2 keyboard trap fixed in #2192/#2727. The
    // liveness property is gated in scheduleTeachingChords.test.tsx; this pins
    // the specific string a reader sees.
    expect(screen.getByText('⌥→')).toBeInTheDocument();
    expect(screen.getByText('the one above becomes a phase')).toBeInTheDocument();
    expect(screen.getByText('wrap them in a phase')).toBeInTheDocument();
  });

  it('says where the bar went, so dismissing it is not a one-way door', () => {
    // The strip this replaces could only be dismissed; a keyboard user who hid
    // it had no route back to the surface that explained the keyboard.
    render(<ScheduleCoachBar onDismiss={() => {}} onShowCheatsheet={() => {}} />);
    expect(
      screen.getByRole('button', { name: /bring it back from Display options/i }),
    ).toBeInTheDocument();
  });

  it('dismisses', async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<ScheduleCoachBar onDismiss={onDismiss} onShowCheatsheet={() => {}} />);
    await user.click(screen.getByRole('button', { name: /Hide the how-to bar/i }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('opens the full cheatsheet', async () => {
    const onShowCheatsheet = vi.fn();
    const user = userEvent.setup();
    render(<ScheduleCoachBar onDismiss={() => {}} onShowCheatsheet={onShowCheatsheet} />);
    await user.click(screen.getByRole('button', { name: /How this works/i }));
    expect(onShowCheatsheet).toHaveBeenCalled();
  });
});
