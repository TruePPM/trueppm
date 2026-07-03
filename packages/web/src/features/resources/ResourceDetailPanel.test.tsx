import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { ResourceDetailPanel } from './ResourceDetailPanel';
import type { OrgResource } from '@/hooks/useResources';

// Mock apiClient so resource-skill reads and the add mutation are controllable.
const { getMock, postMock, patchMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
}));

const SKILL_CATALOG = [
  { id: 'sk-react', name: 'React', normalized_name: 'react', category: 'Frontend' },
];

const RESOURCE: OrgResource = {
  id: 'res-1',
  name: 'Alice Nguyen',
  email: 'alice@example.com',
  jobRole: 'Frontend Engineer',
  calendarId: null,
  maxUnits: 1,
  isDeleted: false,
  skills: [],
};

const paginated = (results: object[]) => ({
  data: { count: results.length, next: null, previous: null, results },
});

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockImplementation((url: string, config?: { params?: { search?: string } }) => {
    if (url === '/resource-skills/') return Promise.resolve(paginated([]));
    if (url === '/skills/') {
      const search = (config?.params?.search ?? '').toLowerCase();
      return Promise.resolve(
        paginated(SKILL_CATALOG.filter((s) => s.name.toLowerCase().includes(search))),
      );
    }
    return Promise.resolve(paginated([]));
  });
  postMock.mockResolvedValue({
    data: { id: 'rs-new', resource: 'res-1', skill: 'sk-react', skill_name: 'React', proficiency: 3 },
  });
});

function renderPanel() {
  return renderWithProviders(
    <ResourceDetailPanel
      mode="view"
      resource={RESOURCE}
      onDeactivated={vi.fn()}
      onRestored={vi.fn()}
    />,
  );
}

describe('ResourceDetailPanel — inline add skill (issue 1612)', () => {
  it('no longer shows the placeholder text and offers an add-skill trigger', () => {
    renderPanel();
    expect(screen.queryByText(/use the project team tab to manage skills/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ add skill/i })).toBeInTheDocument();
  });

  it('adds a skill with the chosen proficiency via the shared combobox', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /\+ add skill/i }));

    // Pick Expert proficiency before choosing the skill.
    await user.click(screen.getByRole('button', { name: 'Expert' }));

    await user.type(screen.getByRole('combobox'), 'react');
    await user.click(await screen.findByRole('option', { name: /react/i }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/resource-skills/', {
        resource: 'res-1',
        skill: 'sk-react',
        proficiency: 3,
      }),
    );
  });

  it('collapses the picker when Cancel is pressed', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /\+ add skill/i }));
    expect(screen.getByRole('combobox')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ add skill/i })).toBeInTheDocument();
  });
});
