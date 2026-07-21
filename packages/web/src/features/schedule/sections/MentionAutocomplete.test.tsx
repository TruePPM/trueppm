/**
 * Tests for the mention autocomplete suggestion builder (#311 phase 2a).
 *
 * Suggestion ordering, group/user split, @all role gate, and prefix filtering
 * are all behaviors clients depend on — covered here with pure-function tests
 * so the component layer can render with confidence.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_VIEWER } from '@/lib/roles';
import type { MentionMemberOption } from '@/hooks/useProjectMembers';
import { buildMentionSuggestions, MentionAutocomplete } from './MentionAutocomplete';

const MEMBERS: MentionMemberOption[] = [
  { id: 'u1', username: 'alice', role: ROLE_MEMBER },
  { id: 'u2', username: 'bob', role: ROLE_MEMBER },
  { id: 'u3', username: 'sarah.chen', role: ROLE_ADMIN },
];

describe('buildMentionSuggestions — group + user ordering', () => {
  it('groups come before individual users when query is empty', () => {
    const out = buildMentionSuggestions('', MEMBERS, ROLE_ADMIN);
    const firstUserIdx = out.findIndex((s) => s.kind === 'user');
    const lastGroupIdx = out.map((s) => s.kind).lastIndexOf('group');
    expect(firstUserIdx).toBeGreaterThan(lastGroupIdx);
  });

  it('limits user suggestions to 10 even when the project has more', () => {
    const many: MentionMemberOption[] = Array.from({ length: 30 }, (_, i) => ({
      id: `u${i}`,
      username: `dev${i}`,
      role: ROLE_MEMBER,
    }));
    const out = buildMentionSuggestions('', many, ROLE_ADMIN);
    expect(out.filter((s) => s.kind === 'user').length).toBe(10);
  });
});

describe('buildMentionSuggestions — prefix filtering', () => {
  it('filters group keys by prefix', () => {
    const out = buildMentionSuggestions('sc', MEMBERS, ROLE_ADMIN);
    const groupKeys = out.filter((s) => s.kind === 'group').map((s) => s.value);
    expect(groupKeys).toEqual(['schedulers', 'scrum-team']);
  });

  it('filters users by username prefix', () => {
    const out = buildMentionSuggestions('al', MEMBERS, ROLE_ADMIN);
    const userValues = out.filter((s) => s.kind === 'user').map((s) => s.value);
    expect(userValues).toEqual(['alice']);
  });

  it('case-insensitive matches for both groups and users', () => {
    const out = buildMentionSuggestions('AL', MEMBERS, ROLE_ADMIN);
    expect(out.find((s) => s.value === 'alice')).toBeDefined();
  });
});

describe('buildMentionSuggestions — @all role gate (ADR-0075 #2)', () => {
  it('@all is disabled for VIEWER users', () => {
    const out = buildMentionSuggestions('all', MEMBERS, ROLE_VIEWER);
    const all = out.find((s) => s.value === 'all');
    expect(all?.disabled).toBe(true);
  });

  it('@all is disabled for MEMBER users (Member is below Admin)', () => {
    const out = buildMentionSuggestions('all', MEMBERS, ROLE_MEMBER);
    const all = out.find((s) => s.value === 'all');
    expect(all?.disabled).toBe(true);
  });

  it('@all is enabled for ADMIN users', () => {
    const out = buildMentionSuggestions('all', MEMBERS, ROLE_ADMIN);
    const all = out.find((s) => s.value === 'all');
    expect(all?.disabled).toBe(false);
  });

  it('@all is disabled when current role is unknown (loading state)', () => {
    const out = buildMentionSuggestions('all', MEMBERS, null);
    const all = out.find((s) => s.value === 'all');
    expect(all?.disabled).toBe(true);
  });

  it('non-@all groups are never role-gated', () => {
    const out = buildMentionSuggestions('', MEMBERS, ROLE_VIEWER);
    const nonAll = out.filter((s) => s.kind === 'group' && s.value !== 'all');
    for (const g of nonAll) {
      expect(g.disabled).toBe(false);
    }
  });
});

describe('MentionAutocomplete — component render', () => {
  it('renders "No matches" when the query filters out everything', () => {
    const onSelect = vi.fn();
    render(
      <MentionAutocomplete
        query="zzznomatch"
        members={MEMBERS}
        currentRole={ROLE_ADMIN}
        highlightIndex={0}
        listboxId="lb"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('renders a listbox of options and calls onSelect when one is mousedown-ed', () => {
    const onSelect = vi.fn();
    const onSuggestionsChange = vi.fn();
    render(
      <MentionAutocomplete
        query="al"
        members={MEMBERS}
        currentRole={ROLE_ADMIN}
        highlightIndex={0}
        listboxId="lb"
        onSelect={onSelect}
        onSuggestionsChange={onSuggestionsChange}
      />,
    );
    expect(onSuggestionsChange).toHaveBeenCalled();
    const aliceOpt = screen.getByText('@alice').closest('[role="option"]') as HTMLElement;
    fireEvent.mouseDown(aliceOpt);
    expect(onSelect).toHaveBeenCalledTimes(1);
    const firstArg = onSelect.mock.calls[0]?.[0] as { value: string } | undefined;
    expect(firstArg?.value).toBe('alice');
  });

  it('shows the Admin+ only badge and does not call onSelect for a disabled @all', () => {
    const onSelect = vi.fn();
    render(
      <MentionAutocomplete
        query="all"
        members={MEMBERS}
        currentRole={ROLE_MEMBER}
        highlightIndex={0}
        listboxId="lb"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText('Admin+ only')).toBeTruthy();
    const allOpt = screen.getByText('@all').closest('[role="option"]') as HTMLElement;
    fireEvent.mouseDown(allOpt);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('buildMentionSuggestions — program groups (#514)', () => {
  const programKeys = ['program-all', 'program-pms', 'program-schedulers', 'program-stakeholders'];

  it('omits @program-* groups when the project has no program', () => {
    const out = buildMentionSuggestions('', MEMBERS, ROLE_ADMIN); // hasProgram defaults to false
    const keys = out.map((s) => s.value);
    for (const k of programKeys) expect(keys).not.toContain(k);
  });

  it('offers all four @program-* groups when the project belongs to a program', () => {
    const out = buildMentionSuggestions('', MEMBERS, ROLE_ADMIN, true);
    const keys = out.map((s) => s.value);
    for (const k of programKeys) expect(keys).toContain(k);
  });

  it('program groups sort after the project groups and before users', () => {
    const out = buildMentionSuggestions('', MEMBERS, ROLE_ADMIN, true);
    const projectAllIdx = out.findIndex((s) => s.value === 'all');
    const programAllIdx = out.findIndex((s) => s.value === 'program-all');
    const firstUserIdx = out.findIndex((s) => s.kind === 'user');
    expect(projectAllIdx).toBeLessThan(programAllIdx);
    expect(programAllIdx).toBeLessThan(firstUserIdx);
  });

  it('prefix-filters program groups like any other group', () => {
    const out = buildMentionSuggestions('program-s', MEMBERS, ROLE_ADMIN, true);
    const keys = out.filter((s) => s.kind === 'group').map((s) => s.value);
    expect(keys).toEqual(['program-schedulers', 'program-stakeholders']);
  });

  it('@program-all is Admin-gated exactly like @all', () => {
    const asMember = buildMentionSuggestions('program-all', MEMBERS, ROLE_MEMBER, true);
    expect(asMember.find((s) => s.value === 'program-all')?.disabled).toBe(true);
    const asAdmin = buildMentionSuggestions('program-all', MEMBERS, ROLE_ADMIN, true);
    expect(asAdmin.find((s) => s.value === 'program-all')?.disabled).toBe(false);
  });

  it('role-banded program groups are never gated', () => {
    const out = buildMentionSuggestions('', MEMBERS, ROLE_VIEWER, true);
    const banded = out.filter(
      (s) => s.kind === 'group' && s.value.startsWith('program-') && s.value !== 'program-all',
    );
    expect(banded.length).toBe(3);
    for (const g of banded) expect(g.disabled).toBe(false);
  });
});

describe('buildMentionSuggestions — user-defined mention groups (#2254)', () => {
  const GROUPS = [
    { name: 'backend-team', memberCount: 4 },
    { name: 'qa', memberCount: 1 },
  ];

  it('offers user-defined mention groups when provided', () => {
    const out = buildMentionSuggestions('', MEMBERS, ROLE_ADMIN, false, GROUPS);
    const values = out.map((s) => s.value);
    expect(values).toContain('backend-team');
    expect(values).toContain('qa');
  });

  it('surfaces none when the group list is empty (default)', () => {
    const out = buildMentionSuggestions('', MEMBERS, ROLE_ADMIN);
    // No @backend-team etc. — only the fixed auto-groups + users.
    expect(out.some((s) => s.value === 'backend-team')).toBe(false);
  });

  it('shows the member count as the hint (singular vs plural)', () => {
    const out = buildMentionSuggestions('', MEMBERS, ROLE_ADMIN, false, GROUPS);
    expect(out.find((s) => s.value === 'backend-team')?.hint).toBe('4 members');
    expect(out.find((s) => s.value === 'qa')?.hint).toBe('1 member');
  });

  it('renders mention groups as kind "group", never disabled', () => {
    const out = buildMentionSuggestions('', MEMBERS, ROLE_VIEWER, false, GROUPS);
    const g = out.find((s) => s.value === 'backend-team');
    expect(g?.kind).toBe('group');
    expect(g?.disabled).toBeFalsy();
  });

  it('sorts after the auto-groups and before individual users', () => {
    const out = buildMentionSuggestions('', MEMBERS, ROLE_ADMIN, false, GROUPS);
    const autoAllIdx = out.findIndex((s) => s.value === 'all');
    const groupIdx = out.findIndex((s) => s.value === 'backend-team');
    const firstUserIdx = out.findIndex((s) => s.kind === 'user');
    expect(autoAllIdx).toBeLessThan(groupIdx);
    expect(groupIdx).toBeLessThan(firstUserIdx);
  });

  it('prefix-filters mention groups by name', () => {
    const out = buildMentionSuggestions('back', MEMBERS, ROLE_ADMIN, false, GROUPS);
    const values = out.filter((s) => s.kind === 'group').map((s) => s.value);
    expect(values).toContain('backend-team');
    expect(values).not.toContain('qa');
  });
});
