import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ConversionNotice, __resetConversionNotices } from './ConversionNotice';
import { FIXTURE_TASKS } from '@/fixtures/tasks';
import type { Task } from '@/types';

function t(over: Partial<Task> & { id: string }): Task {
  return { ...FIXTURE_TASKS[0], isSummary: false, autoContainer: false, ...over };
}

describe('ConversionNotice', () => {
  beforeEach(() => __resetConversionNotices());
  afterEach(cleanup);

  it('says nothing when no row changed identity', () => {
    const { container } = render(<ConversionNotice tasks={[t({ id: 'a', name: 'Permits' })]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('explains the transition, and that the numbers were kept', () => {
    // The whole reason it exists: the parked estimate is real but invisible.
    render(
      <ConversionNotice
        tasks={[t({ id: 'a', name: 'Mobilization', autoContainer: true, ownEstimate: 5 })]}
      />,
    );
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Mobilization');
    expect(notice).toHaveTextContent('became a phase');
    expect(notice).toHaveTextContent('5d');
    expect(notice).toHaveTextContent(/kept, not cleared/i);
  });

  it('stays silent for a phase somebody created on purpose', () => {
    // A DECLARED container never needed explaining — only an accidental one did.
    const { container } = render(
      <ConversionNotice
        tasks={[t({ id: 'a', name: 'Commissioning', isSummary: true, autoContainer: false })]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('tells you once per row, not once per project', async () => {
    // A planner building a twenty-phase WBS does not need the same sentence
    // twenty times.
    const user = userEvent.setup();
    const tasks = [t({ id: 'a', name: 'Mobilization', autoContainer: true, ownEstimate: 5 })];
    const { rerender } = render(<ConversionNotice tasks={tasks} />);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    rerender(<ConversionNotice tasks={[...tasks]} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('still speaks up for a DIFFERENT row that converts later', async () => {
    const user = userEvent.setup();
    const first = t({ id: 'a', name: 'Mobilization', autoContainer: true, ownEstimate: 5 });
    const { rerender } = render(<ConversionNotice tasks={[first]} />);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    const second = t({ id: 'b', name: 'Procurement', autoContainer: true, ownEstimate: 8 });
    rerender(<ConversionNotice tasks={[first, second]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Procurement');
  });

  it('copes with a row that has no parked estimate', () => {
    render(<ConversionNotice tasks={[t({ id: 'a', name: 'Phase', autoContainer: true })]} />);
    expect(screen.getByRole('status')).toHaveTextContent('became a phase');
  });
});
