import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import {
  MentionGroupRow,
  type MentionGroupRowData,
  type ProjectMemberOption,
} from './MentionGroupRow';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseGroup: MentionGroupRowData = {
  id: 'g-1',
  name: 'backend',
  description: 'Backend team',
  email_default_on: false,
  members: [
    { id: 'u-1', username: 'alice', email: 'alice@example.com' },
    { id: 'u-2', username: 'bob', email: 'bob@example.com' },
  ],
  member_count: 2,
  muted_by_me: false,
};

const memberOptions: ProjectMemberOption[] = [
  { userId: 'u-1', username: 'alice' },
  { userId: 'u-2', username: 'bob' },
  { userId: 'u-3', username: 'carol' },
];

function makeHandlers() {
  return {
    onRename: vi.fn<(id: string, name: string) => void>(),
    onDelete: vi.fn<(id: string) => void>(),
    onToggleEmailDefault: vi.fn<(id: string, value: boolean) => void>(),
    onAddMember: vi.fn<(id: string, user: string) => void>(),
    onRemoveMember: vi.fn<(id: string, user: string) => void>(),
    onToggleMute: vi.fn<(id: string, muted: boolean) => void>(),
  };
}

let handlers: ReturnType<typeof makeHandlers>;

function renderRow(
  overrides: {
    group?: Partial<MentionGroupRowData>;
    canManageGroup?: boolean;
    canManageMembers?: boolean;
    memberOptions?: ProjectMemberOption[];
    isBusy?: boolean;
  } = {},
) {
  const group = { ...baseGroup, ...overrides.group };
  return renderWithProviders(
    <ul>
      <MentionGroupRow
        group={group}
        canManageGroup={overrides.canManageGroup ?? true}
        canManageMembers={overrides.canManageMembers ?? true}
        memberOptions={overrides.memberOptions ?? memberOptions}
        onRename={handlers.onRename}
        onDelete={handlers.onDelete}
        onToggleEmailDefault={handlers.onToggleEmailDefault}
        onAddMember={handlers.onAddMember}
        onRemoveMember={handlers.onRemoveMember}
        onToggleMute={handlers.onToggleMute}
        isBusy={overrides.isBusy ?? false}
      />
    </ul>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MentionGroupRow', () => {
  beforeEach(() => {
    handlers = makeHandlers();
  });

  it('renders the @-handle, member count, and description', () => {
    renderRow();
    expect(screen.getByText('@backend')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Backend team')).toBeInTheDocument();
  });

  it('omits the description line when the group has no description', () => {
    renderRow({ group: { description: '' } });
    expect(screen.queryByText('Backend team')).not.toBeInTheDocument();
  });

  it('shows "Mute" and toggles to muted when clicked', async () => {
    const user = userEvent.setup();
    renderRow({ group: { muted_by_me: false } });
    const mute = screen.getByRole('button', { name: 'Mute' });
    expect(mute).toHaveAttribute('aria-pressed', 'false');
    await user.click(mute);
    expect(handlers.onToggleMute).toHaveBeenCalledWith('g-1', true);
  });

  it('shows "Muted" and toggles back to unmuted when already muted', async () => {
    const user = userEvent.setup();
    renderRow({ group: { muted_by_me: true } });
    const mute = screen.getByRole('button', { name: 'Muted' });
    expect(mute).toHaveAttribute('aria-pressed', 'true');
    await user.click(mute);
    expect(handlers.onToggleMute).toHaveBeenCalledWith('g-1', false);
  });

  it('expands the manage panel and lists members', async () => {
    const user = userEvent.setup();
    renderRow();
    const manage = screen.getByRole('button', { name: 'Manage @backend' });
    expect(manage).toHaveAttribute('aria-expanded', 'false');

    await user.click(manage);

    // Button relabels + panel reveals members
    const close = screen.getByRole('button', { name: 'Collapse @backend' });
    expect(close).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('shows the empty-members message when the group has no members', async () => {
    const user = userEvent.setup();
    renderRow({ group: { members: [], member_count: 0 } });
    await user.click(screen.getByRole('button', { name: 'Manage @backend' }));
    expect(screen.getByText('No members yet.')).toBeInTheDocument();
  });

  it('removes a member via the Remove button when the viewer can manage members', async () => {
    const user = userEvent.setup();
    renderRow({ canManageMembers: true });
    await user.click(screen.getByRole('button', { name: 'Manage @backend' }));
    await user.click(screen.getByRole('button', { name: 'Remove alice from @backend' }));
    expect(handlers.onRemoveMember).toHaveBeenCalledWith('g-1', 'u-1');
  });

  it('disables the Remove button while a mutation is in flight', async () => {
    const user = userEvent.setup();
    renderRow({ canManageMembers: true, isBusy: true });
    await user.click(screen.getByRole('button', { name: 'Manage @backend' }));
    expect(screen.getByRole('button', { name: 'Remove alice from @backend' })).toBeDisabled();
  });

  it('hides the Remove control when the viewer cannot manage members', async () => {
    const user = userEvent.setup();
    renderRow({ canManageMembers: false });
    await user.click(screen.getByRole('button', { name: 'Manage @backend' }));
    expect(
      screen.queryByRole('button', { name: 'Remove alice from @backend' }),
    ).not.toBeInTheDocument();
  });

  it('offers only members not already in the group and adds the selected one', async () => {
    const user = userEvent.setup();
    renderRow({ canManageMembers: true });
    await user.click(screen.getByRole('button', { name: 'Manage @backend' }));

    const select = screen.getByLabelText('Add member to @backend');
    // alice + bob are already members → only carol is offered (plus placeholder)
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Add a member…', 'carol']);

    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();

    await user.selectOptions(select, 'u-3');
    expect(add).toBeEnabled();

    await user.click(add);
    expect(handlers.onAddMember).toHaveBeenCalledWith('g-1', 'u-3');
  });

  it('hides the add-member control when every option is already a member', async () => {
    const user = userEvent.setup();
    renderRow({
      canManageMembers: true,
      memberOptions: [
        { userId: 'u-1', username: 'alice' },
        { userId: 'u-2', username: 'bob' },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Manage @backend' }));
    expect(screen.queryByLabelText('Add member to @backend')).not.toBeInTheDocument();
  });

  it('hides the add-member control when the viewer cannot manage members', async () => {
    const user = userEvent.setup();
    renderRow({ canManageMembers: false });
    await user.click(screen.getByRole('button', { name: 'Manage @backend' }));
    expect(screen.queryByLabelText('Add member to @backend')).not.toBeInTheDocument();
  });

  it('reflects and toggles the email-default checkbox for group managers', async () => {
    const user = userEvent.setup();
    renderRow({ canManageGroup: true, group: { email_default_on: false } });
    await user.click(screen.getByRole('button', { name: 'Manage @backend' }));

    const checkbox = screen.getByRole('checkbox', { name: /email members by default/i });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);
    expect(handlers.onToggleEmailDefault).toHaveBeenCalledWith('g-1', true);
  });

  it('hides all group-management controls when the viewer cannot manage the group', async () => {
    const user = userEvent.setup();
    renderRow({ canManageGroup: false });
    await user.click(screen.getByRole('button', { name: 'Manage @backend' }));
    expect(
      screen.queryByRole('checkbox', { name: /email members by default/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete @backend' })).not.toBeInTheDocument();
  });

  it('renames the group to a new trimmed name', async () => {
    const user = userEvent.setup();
    renderRow({ canManageGroup: true });
    await user.click(screen.getByRole('button', { name: 'Manage @backend' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    // While renaming the mute / manage chrome disappears in favor of the editor
    expect(screen.queryByRole('button', { name: 'Mute' })).not.toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: 'Rename group' });
    await user.clear(input);
    await user.type(input, '  frontend  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(handlers.onRename).toHaveBeenCalledWith('g-1', 'frontend');
  });

  it('does not call onRename when the name is unchanged', async () => {
    const user = userEvent.setup();
    renderRow({ canManageGroup: true });
    await user.click(screen.getByRole('button', { name: 'Manage @backend' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    // Leave the draft as-is (still "backend") and save
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(handlers.onRename).not.toHaveBeenCalled();
  });

  it('does not call onRename when the draft is only whitespace', async () => {
    const user = userEvent.setup();
    renderRow({ canManageGroup: true });
    await user.click(screen.getByRole('button', { name: 'Manage @backend' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Rename group' });
    await user.clear(input);
    await user.type(input, '   ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(handlers.onRename).not.toHaveBeenCalled();
  });

  it('cancels a rename and restores the read-only header', async () => {
    const user = userEvent.setup();
    renderRow({ canManageGroup: true });
    await user.click(screen.getByRole('button', { name: 'Manage @backend' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    const input = screen.getByRole('textbox', { name: 'Rename group' });
    await user.clear(input);
    await user.type(input, 'discarded');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(handlers.onRename).not.toHaveBeenCalled();
    // Read-only header is back
    expect(screen.getByText('@backend')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Rename group' })).not.toBeInTheDocument();
  });

  it('requires a two-step confirmation before deleting the group', async () => {
    const user = userEvent.setup();
    renderRow({ canManageGroup: true });
    await user.click(screen.getByRole('button', { name: 'Manage @backend' }));

    await user.click(screen.getByRole('button', { name: 'Delete @backend' }));
    expect(screen.getByText('Delete group?')).toBeInTheDocument();
    // The first-step trigger is replaced by the confirm/cancel pair
    expect(handlers.onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(handlers.onDelete).toHaveBeenCalledWith('g-1');
  });

  it('cancels the delete confirmation without deleting', async () => {
    const user = userEvent.setup();
    renderRow({ canManageGroup: true });
    await user.click(screen.getByRole('button', { name: 'Manage @backend' }));
    await user.click(screen.getByRole('button', { name: 'Delete @backend' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Delete group?')).not.toBeInTheDocument();
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });
});
