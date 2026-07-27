import { screen, waitFor, fireEvent } from '@testing-library/react';
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

const DEACTIVATED: OrgResource = { ...RESOURCE, isDeleted: true };

/** Wire-shape resource (snake_case) returned by the write endpoints. */
const RESOURCE_WIRE = {
  id: 'res-1',
  server_version: 2,
  name: 'Alice Nguyen',
  email: 'alice@example.com',
  job_role: 'Frontend Engineer',
  calendar: null,
  max_units: '1.0',
  is_deleted: false,
  skills: [],
};

const paginated = (results: object[]) => ({
  data: { count: results.length, next: null, previous: null, results },
});

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  patchMock.mockReset();
  deleteMock.mockReset();
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
  patchMock.mockResolvedValue({ data: RESOURCE_WIRE });
  deleteMock.mockResolvedValue({ data: null });
});

function renderPanel(resource: OrgResource = RESOURCE) {
  const onDeactivated = vi.fn();
  const onRestored = vi.fn();
  const view = renderWithProviders(
    <ResourceDetailPanel
      mode="view"
      resource={resource}
      onDeactivated={onDeactivated}
      onRestored={onRestored}
    />,
  );
  return { ...view, onDeactivated, onRestored };
}

function renderCreate() {
  const onCreated = vi.fn<(id: string) => void>();
  const onCancel = vi.fn();
  const view = renderWithProviders(
    <ResourceDetailPanel mode="create" onCreated={onCreated} onCancel={onCancel} />,
  );
  return { ...view, onCreated, onCancel };
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

  it('collapses the picker when Escape is pressed in the combobox', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /\+ add skill/i }));
    await user.type(screen.getByRole('combobox'), '{Escape}');

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ add skill/i })).toBeInTheDocument();
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

describe('ResourceDetailPanel — view/edit form', () => {
  it('seeds the form from the selected resource', () => {
    renderPanel();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Alice Nguyen');
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue('alice@example.com');
    expect(screen.getByRole('textbox', { name: 'Job role' })).toHaveValue('Frontend Engineer');
    // 1.0 FTE renders as 100% in the default percent unit.
    expect(screen.getByRole('spinbutton')).toHaveValue(100);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('disables Save until a field actually changes', async () => {
    const user = userEvent.setup();
    renderPanel();
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), '!');
    expect(save).toBeEnabled();
  });

  it('re-disables Save when an edit is typed back to the original value', async () => {
    const user = userEvent.setup();
    renderPanel();
    const email = screen.getByRole('textbox', { name: 'Email' });
    await user.type(email, 'x');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();

    await user.type(email, '{backspace}');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('enables Save when only the capacity changes and patches the decimal value', async () => {
    const user = userEvent.setup();
    renderPanel();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '50' } });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/resources/res-1/', {
        name: 'Alice Nguyen',
        email: 'alice@example.com',
        job_role: 'Frontend Engineer',
        max_units: 0.5,
      }),
    );
  });

  it('patches the edited fields when Save is pressed', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.clear(screen.getByRole('textbox', { name: 'Job role' }));
    await user.type(screen.getByRole('textbox', { name: 'Job role' }), 'Staff Engineer');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/resources/res-1/', {
        name: 'Alice Nguyen',
        email: 'alice@example.com',
        job_role: 'Staff Engineer',
        max_units: 1,
      }),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the server error message when the save is rejected', async () => {
    const user = userEvent.setup();
    patchMock.mockRejectedValue(new Error('Resource name already taken'));
    renderPanel();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Resource name already taken');
  });

  it('falls back to the permission hint when the rejection carries no message', async () => {
    const user = userEvent.setup();
    // A non-Error rejection (e.g. an interceptor rejecting with a bare payload).
    patchMock.mockRejectedValue({ status: 403 });
    renderPanel();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /you may not have permission to edit resources/i,
    );
  });

  it('shows a pending label while the save is in flight', async () => {
    const user = userEvent.setup();
    patchMock.mockReturnValue(new Promise(() => {}));
    renderPanel();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const saving = await screen.findByRole('button', { name: 'Saving…' });
    expect(saving).toBeDisabled();
  });

  it('resets the form when a different resource is selected', async () => {
    const user = userEvent.setup();
    const { rerender } = renderPanel();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), ' (edited)');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Alice Nguyen (edited)');

    rerender(
      <ResourceDetailPanel
        mode="view"
        resource={{ ...RESOURCE, id: 'res-2', name: 'Bo Chen', jobRole: 'Designer' }}
        onDeactivated={vi.fn()}
        onRestored={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Bo Chen');
    expect(screen.getByRole('textbox', { name: 'Job role' })).toHaveValue('Designer');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});

describe('ResourceDetailPanel — deactivate/restore', () => {
  it('requires confirmation before deactivating and can back out', async () => {
    const user = userEvent.setup();
    const { onDeactivated } = renderPanel();

    await user.click(screen.getByRole('button', { name: '⚠ Deactivate' }));
    expect(screen.getByText('Deactivate Alice Nguyen?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Deactivate Alice Nguyen?')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '⚠ Deactivate' })).toBeInTheDocument();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(onDeactivated).not.toHaveBeenCalled();
  });

  it('deactivates and notifies the parent on confirm', async () => {
    const user = userEvent.setup();
    const { onDeactivated } = renderPanel();

    await user.click(screen.getByRole('button', { name: '⚠ Deactivate' }));
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/resources/res-1/'));
    await waitFor(() => expect(onDeactivated).toHaveBeenCalledTimes(1));
    // The confirm row collapses again.
    expect(screen.getByRole('button', { name: '⚠ Deactivate' })).toBeInTheDocument();
  });

  it('renders the deactivated read-only state instead of the edit footer', () => {
    renderPanel(DEACTIVATED);

    expect(screen.getByRole('status')).toHaveTextContent(/deactivated and hidden/i);
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Email' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restore resource' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '⚠ Deactivate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /\+ add skill/i })).not.toBeInTheDocument();
  });

  it('restores a deactivated resource and notifies the parent', async () => {
    const user = userEvent.setup();
    postMock.mockResolvedValue({ data: RESOURCE_WIRE });
    const { onRestored } = renderPanel(DEACTIVATED);

    await user.click(screen.getByRole('button', { name: 'Restore resource' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/resources/res-1/restore/'));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
  });

  it('shows a pending label while the restore is in flight', async () => {
    const user = userEvent.setup();
    postMock.mockReturnValue(new Promise(() => {}));
    renderPanel(DEACTIVATED);

    await user.click(screen.getByRole('button', { name: 'Restore resource' }));
    expect(await screen.findByRole('button', { name: 'Restoring…' })).toBeDisabled();
  });
});

describe('ResourceDetailPanel — skills list', () => {
  const TAGGED_SKILL = {
    id: 'rs-1',
    resource: 'res-1',
    skill: 'sk-react',
    skill_name: 'React',
    proficiency: 2,
  };

  function withTaggedSkill() {
    getMock.mockImplementation((url: string) => {
      if (url === '/resource-skills/') return Promise.resolve(paginated([TAGGED_SKILL]));
      return Promise.resolve(paginated([]));
    });
  }

  it('shows the empty hint when no skills are tagged', () => {
    renderPanel();
    expect(screen.getByText('No skills tagged.')).toBeInTheDocument();
  });

  it('lists tagged skills with a remove control', async () => {
    withTaggedSkill();
    const user = userEvent.setup();
    renderPanel();

    const remove = await screen.findByRole('button', { name: 'Remove React skill' });
    expect(screen.queryByText('No skills tagged.')).not.toBeInTheDocument();

    await user.click(remove);
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/resource-skills/rs-1/'));
  });

  it('hides the remove control on a deactivated resource', async () => {
    withTaggedSkill();
    renderPanel(DEACTIVATED);

    expect(await screen.findByText('React')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove React skill' })).not.toBeInTheDocument();
  });
});

describe('ResourceDetailPanel — create mode', () => {
  it('focuses the name field and marks it required', () => {
    renderCreate();
    const name = screen.getByRole('textbox', { name: 'Name' });
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute('placeholder', 'e.g. Maria Chen');
    // The required marker is decorative but present next to the label.
    expect(screen.getByText('Name').textContent).toContain('*');
  });

  it('keeps Create disabled until a non-blank name is entered', async () => {
    const user = userEvent.setup();
    renderCreate();
    const create = screen.getByRole('button', { name: 'Create resource' });
    expect(create).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), '   ');
    expect(create).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Maria Chen');
    expect(create).toBeEnabled();
  });

  it('creates the resource with the trimmed name and reports the new id', async () => {
    const user = userEvent.setup();
    postMock.mockResolvedValue({ data: { ...RESOURCE_WIRE, id: 'res-new' } });
    const { onCreated } = renderCreate();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), '  Maria Chen  ');
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'maria@company.com');
    await user.type(screen.getByRole('textbox', { name: 'Job role' }), 'Senior Engineer');
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '75' } });
    await user.click(screen.getByRole('button', { name: 'Create resource' }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/resources/', {
        name: 'Maria Chen',
        email: 'maria@company.com',
        job_role: 'Senior Engineer',
        max_units: 0.75,
      }),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('res-new'));
  });

  it('surfaces the server message when creation fails', async () => {
    const user = userEvent.setup();
    postMock.mockRejectedValue(new Error('A resource with that email exists'));
    const { onCreated } = renderCreate();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Maria Chen');
    await user.click(screen.getByRole('button', { name: 'Create resource' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A resource with that email exists');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the rejection carries no message', async () => {
    const user = userEvent.setup();
    postMock.mockRejectedValue({ status: 500 });
    renderCreate();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Maria Chen');
    await user.click(screen.getByRole('button', { name: 'Create resource' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to create resource.');
  });

  it('shows a pending label while the create is in flight', async () => {
    const user = userEvent.setup();
    postMock.mockReturnValue(new Promise(() => {}));
    renderCreate();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Maria Chen');
    await user.click(screen.getByRole('button', { name: 'Create resource' }));

    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDisabled();
  });

  it('cancels without creating anything', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderCreate();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('does not render the view-mode chrome', () => {
    renderCreate();
    expect(screen.queryByRole('button', { name: '⚠ Deactivate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /\+ add skill/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
