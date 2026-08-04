import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BlankProjectCanvas } from './BlankProjectCanvas';

const FACTS = {
  startDate: '2026-09-07',
  calendarName: 'Site calendar',
  defaultMode: 'HYBRID',
  views: ['SCHEDULE'],
};

describe('BlankProjectCanvas (#2733)', () => {
  it('draws a horizon so an empty project reads as a plan surface', () => {
    // An empty grid says "nothing is planned yet"; a blank panel says "something
    // is broken". The ruler is the difference.
    const { container } = render(<BlankProjectCanvas facts={FACTS} />);
    // The horizon is decorative to AT (the facts list carries the same
    // information in text), so assert on the rendered week cells.
    expect(container.querySelectorAll('[aria-hidden="true"] .w-24').length).toBeGreaterThan(0);
  });

  it('states the project facts that make the horizon legible', () => {
    // Gridlines with no named calendar behind them explain nothing.
    render(<BlankProjectCanvas facts={FACTS} />);
    expect(screen.getByText('Site calendar')).toBeInTheDocument();
    expect(screen.getByText('2026-09-07')).toBeInTheDocument();
    expect(screen.getByText('HYBRID')).toBeInTheDocument();
  });

  it('renders em-dashes rather than blanks for facts the project has not set', () => {
    render(<BlankProjectCanvas facts={{}} />);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('offers the fill options quietly, as secondary actions', async () => {
    // Quiet is a requirement, not a style note: these compete with the live row in
    // the outline, which is the path most people should take. None of them may be
    // a primary button.
    const onImport = vi.fn();
    render(<BlankProjectCanvas facts={FACTS} onImportFile={onImport} />);

    const button = screen.getByRole('button', { name: /import a file/i });
    expect(button.className).not.toMatch(/bg-brand-primary/);
    await userEvent.click(button);
    expect(onImport).toHaveBeenCalledOnce();
  });

  it('hides the fill section entirely for a read-only role', () => {
    // Every fill option writes, so offering them disabled would be a row of dead
    // affordances rather than an invitation.
    render(<BlankProjectCanvas facts={FACTS} />);
    expect(screen.queryByText(/other ways to fill it/i)).not.toBeInTheDocument();
    // ...but the facts still render — a Viewer should still see what this project is.
    expect(screen.getByText('Site calendar')).toBeInTheDocument();
  });
});
