import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import type { Risk } from '@/api/types';
import { RiskRegisterView } from './RiskRegisterView';

const FIXTURE_RISK: Risk = {
  id: 'risk-001',
  short_id: '00000001',
  server_version: 1,
  project: 'p1',
  title: 'Critical infrastructure failure',
  description: 'Infra may fail',
  status: 'OPEN',
  probability: 5,
  impact: 5,
  severity: 25,
  owner: null,
  owner_name: null,
  owner_initials: null,
  created_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  tasks: [],
  category: 'TECHNICAL',
  response: 'MITIGATE',
  mitigation_due_date: null,
  trigger: '',
  contingency: '',
};

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => 'p1',
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({ data: [{ id: 'p1', name: 'Test Project' }] }),
}));

vi.mock('@/hooks/useRisks', () => ({
  useRisks: () => ({ risks: [FIXTURE_RISK], isLoading: false, error: null }),
  useCreateRisk: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useUpdateRisk: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteRisk: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRiskComments: () => ({ comments: [], isLoading: false }),
  useCreateRiskComment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

describe('RiskRegisterView — drawer layout (issue #293)', () => {
  it('renders the drawer as a sibling of the table column inside the two-column flex container', () => {
    renderWithProviders(<RiskRegisterView />);

    // Open the drawer by clicking the risk row
    const row = screen.getByRole('button', { name: /Open risk: Critical infrastructure failure/ });
    fireEvent.click(row);

    // The first dialog rendered is the desktop inline panel (rule 89).
    // RiskDrawer renders both desktop and mobile variants; we assert against
    // the desktop one which must be a flex sibling of the table column.
    const dialogs = screen.getAllByRole('dialog', { name: 'Critical infrastructure failure' });
    const desktopDialog = dialogs.find((el) => el.className.includes('md:flex'));
    expect(desktopDialog, 'desktop dialog variant should be rendered').toBeDefined();

    const table = screen.getByRole('table');
    const tableColumn = table.closest('div.flex-1.min-w-0');
    expect(tableColumn, 'table column wrapper should exist').not.toBeNull();

    // The bug: drawer was rendered outside the two-column flex parent, so it
    // stacked below the page content. The fix puts it inside, as a flex sibling
    // of the table column. Verify they share the same direct parent.
    expect(desktopDialog!.parentElement).toBe(tableColumn!.parentElement);

    // And that shared parent must be the two-column flex row container
    expect(tableColumn!.parentElement?.className).toMatch(/\bflex\b/);
    expect(tableColumn!.parentElement?.className).toMatch(/gap-4/);
  });
});
