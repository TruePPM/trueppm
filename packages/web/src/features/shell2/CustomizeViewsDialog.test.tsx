import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectViewSet, ResolvedView } from '@/api/types';
import { CustomizeViewsDialog, buildRows } from './CustomizeViewsDialog';

const patch = vi.fn();
const reset = vi.fn();
const state = { error: null as unknown, isError: false };
vi.mock('@/hooks/useProjectViews', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useProjectViews')>()),
  useUpdateProjectViews: () => ({
    mutate: patch,
    isPending: false,
    error: state.error,
    isError: state.isError,
  }),
  useResetProjectViews: () => ({ mutate: reset, isPending: false, error: null, isError: false }),
}));
vi.mock('@/lib/featureFlags', () => ({ useFeatureFlag: () => true }));
vi.mock('@/hooks/useUserDateFormat', () => ({
  useUserDateFormat: () => ({ formatInstantDate: () => 'Nov 12' }),
}));
const fmt = () => 'Nov 12';

const v = (key: string, extra: Partial<ResolvedView> = {}): ResolvedView => ({
  key,
  visible: true,
  source: 'default',
  binding: 'advisory',
  lens: null,
  at: null,
  ...extra,
});

const SET: ProjectViewSet = {
  views: [
    v('overview', { source: 'always' }),
    v('schedule', { visible: false, source: 'seed', lens: 'scrum_master' }),
    v('grid'),
    v('calendar', { visible: false, source: 'seed', lens: 'scrum_master' }),
    v('board'),
    v('reports', { visible: false, source: 'user', at: '2026-11-12T10:00:00Z' }),
    v('assets', { visible: false, source: 'capability', binding: 'enforced' }),
  ],
  lens: 'scrum_master',
  seeded_lens: 'scrum_master',
  seed_line: null,
  lens_offer: null,
  landing: 'board',
  last_layouts: {},
};
const LABELS: Record<string, string> = {
  overview: 'Overview',
  schedule: 'Gantt',
  grid: 'Grid',
  calendar: 'Calendar',
  board: 'Board',
  reports: 'Reports',
  assets: 'Assets',
};
const label = (k: string) => LABELS[k] ?? k;

function renderDialog(onClose = vi.fn()) {
  render(
    <CustomizeViewsDialog
      projectId="p"
      projectName="Atlas Migration"
      workspaceName="Northwind"
      viewSet={SET}
      labelFor={label}
      onClose={onClose}
    />,
  );
  return onClose;
}

beforeEach(() => {
  patch.mockReset();
  reset.mockReset();
  state.error = null;
  state.isError = false;
});

describe('buildRows', () => {
  it('labels each row by its server source', () => {
    const rows = Object.fromEntries(
      buildRows(SET, label, 'Northwind', fmt).map((r) => [r.view.key, r]),
    );
    expect(rows.overview?.status).toBe('■ Always on');
    expect(rows.schedule?.status).toBe('◌ Suggested hidden · Scrum Master');
    expect(rows.board?.status).toBe('Shown');
    expect(rows.reports?.status).toBe('⊖ Hidden by you · Nov 12');
    expect(rows.assets?.status).toBe('⊘ Off in Northwind');
    expect(rows.assets?.askAdmin).toBe(true);
  });

  it('locks the last visible Plan layout and says why', () => {
    const grid = buildRows(SET, label, undefined, fmt).find((r) => r.view.key === 'grid');
    expect(grid?.label).toBe('Plan › Grid');
    expect(grid?.status).toBe('■ Always on');
    expect(grid?.locked).toBe("The last Plan layout can't be hidden.");
  });
});

describe('CustomizeViewsDialog', () => {
  it('is a labelled dialog that shows a hidden view on toggle', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Views in Atlas Migration' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Plan › Gantt: hidden' }));
    expect(patch).toHaveBeenCalledWith({ key: 'schedule', hidden: false });
    fireEvent.click(screen.getByRole('switch', { name: 'Board: shown' }));
    expect(patch).toHaveBeenCalledWith({ key: 'board', hidden: true });
  });

  it('keeps locked switches focusable but inert', () => {
    renderDialog();
    const grid = screen.getByRole('switch', { name: 'Plan › Grid: shown' });
    expect(grid).toHaveAttribute('aria-disabled', 'true');
    expect(grid).not.toBeDisabled();
    fireEvent.click(grid);
    fireEvent.click(screen.getByRole('switch', { name: 'Assets: hidden' }));
    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByText('Ask an admin')).toBeInTheDocument();
  });

  it('resets to the lens suggestions and closes on Escape', () => {
    const onClose = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to Scrum Master suggestions' }));
    expect(reset).toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the server's last_plan_layout refusal", () => {
    state.error = {
      response: { data: { code: 'last_plan_layout', detail: 'Plan needs a layout.' } },
    };
    state.isError = true;
    renderDialog();
    expect(screen.getByRole('alert')).toHaveTextContent('Plan needs a layout.');
  });
});
