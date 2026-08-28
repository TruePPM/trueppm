import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Task } from '@/types';
import { FIXTURE_TASKS } from '@/fixtures/tasks';
import { ReforecastPanel } from './ReforecastPanel';
import type { ReconcileEntries } from '../reconcile/reconcileState';

function t(id: string, name: string): Task {
  return { ...FIXTURE_TASKS[0], id, name };
}
const TASKS = [t('permits', 'Permits'), t('survey', 'Survey')];
const LINKS = [{ sourceId: 'permits', targetId: 'survey' }];

function diverged(...ids: string[]): ReconcileEntries {
  return Object.fromEntries(
    ids.map((id) => [
      `${id}:finish`,
      {
        taskId: id,
        field: 'finish' as const,
        taskName: TASKS.find((x) => x.id === id)?.name ?? id,
        status: 'diverged' as const,
        expected: '2026-04-10',
        actual: '2026-04-14',
        reason: null,
      },
    ]),
  ) as ReconcileEntries;
}

const props = {
  links: LINKS,
  tasks: TASKS,
  cpmFinish: 'Oct 16',
  p80: 'Oct 24',
  onDismiss: () => {},
};

/**
 * A row nobody on this client touched: no `taskName` (the delta path has no name
 * to give), and `status: 'cascade'` rather than `diverged` (#3041).
 */
function cascade(...ids: string[]): ReconcileEntries {
  return Object.fromEntries(
    ids.map((id) => [
      `${id}:finish`,
      {
        taskId: id,
        field: 'finish' as const,
        taskName: '',
        status: 'cascade' as const,
        expected: '2026-04-10',
        actual: '2026-04-14',
        reason: null,
      },
    ]),
  ) as ReconcileEntries;
}

describe('ReforecastPanel — cascade rows (#3041)', () => {
  afterEach(cleanup);

  it('lists rows the user never touched, with the driver named', () => {
    // The whole finding: before this, neither row reached the panel unless THIS
    // user had just written it — so the panel that exists to explain a downstream
    // cascade could show every row except the cascade. Nobody on this client
    // touched either of these.
    render(<ReforecastPanel {...props} entries={cascade('permits', 'survey')} />);
    expect(screen.getByRole('region', { name: 'What moved and why' })).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Permits');
    expect(rows[1]).toHaveTextContent('moved because Permits moved');
  });

  it('resolves the name from tasks, since a cascade entry carries none', () => {
    render(<ReforecastPanel {...props} entries={cascade('permits')} />);
    expect(screen.getByText('Permits')).toBeInTheDocument();
    expect(screen.queryByText('Untitled')).not.toBeInTheDocument();
  });

  it('orders a cascade under the local edit that drove it', () => {
    const entries = { ...diverged('permits'), ...cascade('survey') };
    render(<ReforecastPanel {...props} entries={entries} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // Cause first, consequence under it — the panel's whole point.
    expect(rows[0]).toHaveTextContent('Permits');
    expect(rows[1]).toHaveTextContent('Survey');
    expect(rows[1]).toHaveTextContent('moved because Permits moved');
  });

  it('still refuses to invent a cause for an unattributable move', () => {
    // `permits` has no driver in LINKS. It must read "changed on its own", not a
    // plausible guess — the client cannot know why the engine moved a date.
    render(<ReforecastPanel {...props} entries={cascade('permits')} />);
    expect(screen.getByText('changed on its own')).toBeInTheDocument();
  });
});

describe('ReforecastPanel', () => {
  afterEach(cleanup);

  it('renders nothing when nothing diverged', () => {
    const { container } = render(<ReforecastPanel {...props} entries={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('separates causes from consequences instead of listing a count', () => {
    // "2 dates changed" is alarming and uninformative; this is actionable.
    render(<ReforecastPanel {...props} entries={diverged('permits', 'survey')} />);
    expect(screen.getByText('1 change moved 1 other date.')).toBeInTheDocument();
  });

  it('names the driver of a pushed row', () => {
    render(<ReforecastPanel {...props} entries={diverged('permits', 'survey')} />);
    const items = screen.getAllByRole('listitem');
    expect(items[1]).toHaveTextContent(/moved because/);
    expect(items[1]).toHaveTextContent('Permits');
  });

  it('marks a row that changed on its own account rather than leaving it blank', () => {
    // "No driver" is the finding, not missing data — these are the rows to read.
    render(<ReforecastPanel {...props} entries={diverged('permits', 'survey')} />);
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('changed on its own');
  });

  it('shows the deterministic finish AND P80 together', () => {
    // A CPM date alone reads as a promise; a P80 alone hides the critical path.
    render(<ReforecastPanel {...props} entries={diverged('permits')} />);
    expect(screen.getByText('Oct 16')).toBeInTheDocument();
    expect(screen.getByText('Oct 24')).toBeInTheDocument();
  });

  it('says WHY P80 is absent rather than showing one date as the whole answer', () => {
    render(<ReforecastPanel {...props} p80={null} entries={diverged('permits')} />);
    expect(screen.getByText(/no forecast run yet/i)).toBeInTheDocument();
  });

  it('counts a task once when both its dates moved', () => {
    // Two fields, one change as far as a planner is concerned.
    const both = {
      ...diverged('permits'),
      'permits:start': { ...diverged('permits')['permits:finish'], field: 'start' as const },
    } as ReconcileEntries;
    render(<ReforecastPanel {...props} entries={both} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('dismisses', async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<ReforecastPanel {...props} onDismiss={onDismiss} entries={diverged('permits')} />);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
