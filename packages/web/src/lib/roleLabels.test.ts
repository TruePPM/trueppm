import { describe, expect, it } from 'vitest';
import { ROLE_VIEWER, ROLE_MEMBER, ROLE_SCHEDULER, ROLE_ADMIN, ROLE_OWNER } from './roles';
import { GRANTABLE_ROLES, roleDescription, roleLabel } from './roleLabels';

/**
 * #3476 — the vocabulary is scope-dependent and the two scopes must be pinned
 * against each other, not each on its own: the defect was a program surface
 * silently reusing the project names, which any single-scope test passes.
 */
describe('roleLabel', () => {
  it('names the top two roles for the container they govern', () => {
    expect(roleLabel(ROLE_ADMIN, 'project')).toBe('Project Manager');
    expect(roleLabel(ROLE_ADMIN, 'program')).toBe('Program Manager');
    expect(roleLabel(ROLE_OWNER, 'project')).toBe('Project Admin');
    expect(roleLabel(ROLE_OWNER, 'program')).toBe('Program Admin');
  });

  it('keeps the person-shaped roles identical across scopes', () => {
    // Viewer/Team Member/Resource Manager describe a person, not a container, so
    // a scope split there would be churn — assert they do NOT diverge.
    for (const role of [ROLE_VIEWER, ROLE_MEMBER, ROLE_SCHEDULER]) {
      expect(roleLabel(role, 'program')).toBe(roleLabel(role, 'project'));
    }
  });

  it('matches the server labels the API already sends', () => {
    // `Role.label` (apps/access/models.py) and `_PROGRAM_ROLE_LABELS`
    // (apps/projects/serializers.py) are the two maps this mirrors.
    expect([...GRANTABLE_ROLES, ROLE_OWNER].map((r) => roleLabel(r, 'project'))).toEqual([
      'Viewer',
      'Team Member',
      'Resource Manager',
      'Project Manager',
      'Project Admin',
    ]);
    expect([...GRANTABLE_ROLES, ROLE_OWNER].map((r) => roleLabel(r, 'program'))).toEqual([
      'Viewer',
      'Team Member',
      'Resource Manager',
      'Program Manager',
      'Program Admin',
    ]);
  });

  it('falls back to the server label for an ordinal outside the five OSS roles', () => {
    // ADR-0072 reserves 201–299 for Enterprise custom roles; an ordinal this map
    // does not know is the extension contract working, not a bug. Echo what the
    // server called it rather than borrowing a neighbouring role's name.
    expect(roleLabel(250, 'program', 'Senior Scheduler')).toBe('Senior Scheduler');
    expect(roleLabel(250, 'project', 'Senior Scheduler')).toBe('Senior Scheduler');
  });

  it('degrades to plain copy when neither the map nor the server names it', () => {
    // Never the raw ordinal: an identifier is not user-facing copy (web rule 301(c)).
    expect(roleLabel(250, 'program')).toBe('Unknown role');
    expect(roleLabel(250, 'program', null)).toBe('Unknown role');
  });

  it('never lets a known ordinal be overridden by a stale server label', () => {
    // The program members endpoint currently sends the PROJECT label for a
    // program membership (server-side residual, #3503). The map wins for every
    // ordinal it knows, so that stale string can never reach a user.
    expect(roleLabel(ROLE_OWNER, 'program', 'Project Admin')).toBe('Program Admin');
  });
});

describe('GRANTABLE_ROLES', () => {
  it('offers Viewer through Admin, lowest first, and never Owner', () => {
    expect(GRANTABLE_ROLES).toEqual([ROLE_VIEWER, ROLE_MEMBER, ROLE_SCHEDULER, ROLE_ADMIN]);
    expect(GRANTABLE_ROLES).not.toContain(ROLE_OWNER);
  });

  it('describes every grantable role in both scopes', () => {
    for (const role of GRANTABLE_ROLES) {
      expect(roleDescription(role, 'project')).toBeTruthy();
      expect(roleDescription(role, 'program')).toBeTruthy();
    }
  });

  it('scopes the container-shaped descriptions', () => {
    expect(roleDescription(ROLE_VIEWER, 'project')).toContain('project');
    expect(roleDescription(ROLE_VIEWER, 'program')).toContain('program');
    expect(roleDescription(ROLE_ADMIN, 'project')).toContain('project');
    expect(roleDescription(ROLE_ADMIN, 'program')).toContain('program');
  });
});
