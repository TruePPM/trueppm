import type { ComponentProps } from 'react';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_OWNER } from '@/lib/roles';
import type { ProgramMembership } from '@/api/types';
import { ProgramMemberRow } from './ProgramMemberRow';

/**
 * #3476 — the program members row shipped two defects that no per-surface test
 * could see: its role `<select>` had no accessible name (axe `select-name`,
 * critical, once per member), and it named program roles with project
 * vocabulary.
 */
function makeMembership(overrides: Partial<ProgramMembership> = {}): ProgramMembership {
  return {
    id: 'm-1',
    server_version: 1,
    program: 'p-1',
    user: 'u-1',
    user_detail: { id: 'u-1', username: 'alice', email: 'alice@example.com' },
    role: ROLE_MEMBER,
    role_label: 'Team Member',
    joined_at: '2026-01-01T00:00:00Z',
    role_changed_at: null,
    ...overrides,
  };
}

function renderRow(
  membership: ProgramMembership,
  props: Partial<ComponentProps<typeof ProgramMemberRow>> = {},
) {
  return renderWithProviders(
    <ul>
      <ProgramMemberRow
        membership={membership}
        isSelf={false}
        isOwnerRole
        isSoleOwner={false}
        onChangeRole={vi.fn()}
        onRemove={vi.fn()}
        isUpdatingRole={false}
        isRemoving={false}
        {...props}
      />
    </ul>,
  );
}

describe('ProgramMemberRow — accessible name on the role select', () => {
  it('names the select after the member whose role it changes', () => {
    renderRow(makeMembership());
    expect(screen.getByRole('combobox')).toHaveAccessibleName('Role for alice');
  });

  it('gives each row a distinct name so a list of them is not N bare "combo box"es', () => {
    renderWithProviders(
      <ul>
        <ProgramMemberRow
          membership={makeMembership()}
          isSelf={false}
          isOwnerRole
          isSoleOwner={false}
          onChangeRole={vi.fn()}
          onRemove={vi.fn()}
          isUpdatingRole={false}
          isRemoving={false}
        />
        <ProgramMemberRow
          membership={makeMembership({
            id: 'm-2',
            user: 'u-2',
            user_detail: { id: 'u-2', username: 'sofia.p', email: 'sofia@example.com' },
          })}
          isSelf={false}
          isOwnerRole
          isSoleOwner={false}
          onChangeRole={vi.fn()}
          onRemove={vi.fn()}
          isUpdatingRole={false}
          isRemoving={false}
        />
      </ul>,
    );
    expect(screen.getByRole('combobox', { name: 'Role for alice' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Role for sofia.p' })).toBeInTheDocument();
  });

  it('keeps the name free of the "(you)" annotation beside the username', () => {
    // The row's name cell renders `{username}` next to a `(you)` span, so an
    // `aria-labelledby` pointing at it would compute "alice(you)" — accname trims
    // each text node before joining. The explicit label is what avoids that.
    renderRow(makeMembership(), { isSelf: true });
    expect(screen.getByRole('combobox')).toHaveAccessibleName('Role for alice');
  });
});

describe('ProgramMemberRow — program vocabulary', () => {
  it('offers program role names in the picker, never project ones', () => {
    renderRow(makeMembership());
    const options = Array.from(screen.getByRole('combobox').querySelectorAll('option')).map(
      (o) => o.textContent,
    );
    expect(options).toEqual(['Viewer', 'Team Member', 'Resource Manager', 'Program Manager']);
    expect(options).not.toContain('Project Manager');
  });

  it('names an Owner row "Program Admin" even though the API sends the project label', () => {
    // The Owner row renders the read-only badge (Owners cannot be re-roled here),
    // and `GET /programs/{id}/members/` still serializes `role_label` through the
    // project-scoped `Role.label` — so rendering `role_label` verbatim is exactly
    // how "Project Admin" reached a program surface.
    renderRow(makeMembership({ role: ROLE_OWNER, role_label: 'Project Admin' }));
    expect(screen.getByText('Program Admin')).toBeInTheDocument();
    expect(screen.queryByText('Project Admin')).not.toBeInTheDocument();
  });

  it('falls back to the server label for an Enterprise custom-band ordinal', () => {
    // 250 sits in ADR-0072's reserved Scheduler band; the client cannot name it,
    // so it echoes the server rather than inventing or printing a bare number.
    renderRow(makeMembership({ role: 250, role_label: 'Senior Scheduler' }), {
      isOwnerRole: false,
    });
    expect(screen.getByText('Senior Scheduler')).toBeInTheDocument();
  });

  it('shows the badge, not a picker, when the caller is not an Owner', () => {
    renderRow(makeMembership({ role: ROLE_ADMIN, role_label: 'Project Manager' }), {
      isOwnerRole: false,
    });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('Program Manager')).toBeInTheDocument();
  });
});
