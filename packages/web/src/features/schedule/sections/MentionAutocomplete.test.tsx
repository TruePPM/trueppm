/**
 * Tests for the mention autocomplete suggestion builder (#311 phase 2a).
 *
 * Suggestion ordering, group/user split, @all role gate, and prefix filtering
 * are all behaviors clients depend on — covered here with pure-function tests
 * so the component layer can render with confidence.
 */

import { describe, it, expect } from 'vitest';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_VIEWER } from '@/lib/roles';
import type { MentionMemberOption } from '@/hooks/useProjectMembers';
import { buildMentionSuggestions } from './MentionAutocomplete';

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
