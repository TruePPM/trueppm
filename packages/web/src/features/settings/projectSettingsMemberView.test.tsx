import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canAuthorPlan } from '@/lib/roles';
import {
  buildProjectSettingsMemberNav,
  buildProjectSettingsNav,
  resolveProjectSettingsRail,
  shouldShowProjectMemberRail,
  ProjectSettingsPage,
} from './ProjectSettingsPage';

const mockUser = vi.hoisted(() => ({
  user: undefined as { can_access_admin_settings?: boolean } | undefined,
}));

vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => mockUser }));
const mockWs = vi.hoisted(() => ({ isAdmin: false as boolean | null }));
vi.mock('@/hooks/useIsWorkspaceAdmin', () => ({ useIsWorkspaceAdmin: () => mockWs.isAdmin }));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p1' }));
const mockProject = vi.hoisted(() => ({
  data: undefined as { name: string; my_role?: number | null } | undefined,
}));
vi.mock('@/hooks/useProject', () => ({ useProject: () => mockProject }));
vi.mock('@/hooks/usePrograms', () => ({ usePrograms: () => ({ data: [] }) }));
vi.mock('@/hooks/useProjects', () => ({ useProjects: () => ({ data: [] }) }));
vi.mock('./project/ProjectTemplateDivergencePage', () => ({
  ProjectTemplateDivergencePage: () => <div>divergence stub</div>,
}));
vi.mock('./project/ProjectGeneralPage', () => ({
  ProjectGeneralPage: () => <div>general stub</div>,
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1/settings']}>
      <ProjectSettingsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockUser.user = undefined;
  mockWs.isAdmin = false;
  mockProject.data = undefined;
});

/**
 * The reduced project-settings rail a non-admin member sees (#2971).
 *
 * The failure this pins is not "a section is missing" — it is the whole issue:
 * project settings was admin-only end to end (`RequireAdminSettings` bounces
 * anyone whose org-wide `can_access_admin_settings` is false), so a divergence
 * digest mounted only on the consolidated page would have been readable by the
 * PMO and unreachable by the team it reports on. The endpoint answering a Viewer
 * with 200 proves nothing on its own if no route renders it.
 */
describe('project settings — member view', () => {
  it('carries the divergence digest, the one section a member is here for', () => {
    const ids = buildProjectSettingsMemberNav().flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('template-divergence');
  });

  it('carries nothing a non-admin cannot act on', () => {
    // A declared allow-list, not a filter: a section becomes member-visible by
    // being named in the member builder. If this ever grows, it must grow by
    // someone deciding it should — which is what makes this assertion worth having
    // even though it looks like it just restates the builder.
    const ids = buildProjectSettingsMemberNav().flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual(['template-divergence']);
  });

  it('uses the same section id as the admin rail, so one anchor serves both', () => {
    // `/projects/:id/settings#template-divergence` must resolve for an admin and a
    // member alike. Two ids would mean two addresses for one report, which is the
    // seam a "PMO copy" would eventually grow out of.
    const adminIds = buildProjectSettingsNav({
      showTeamTab: true,
      iterationSingular: 'Sprint',
    }).flatMap((g) => g.items.map((i) => i.id));
    expect(adminIds).toContain('template-divergence');
  });

  it('labels the member rail for its audience, not as a subset of the admin one', () => {
    const groups = buildProjectSettingsMemberNav();
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Your project');
  });

  it('resolves the rail from the caller role on THIS project (#3005)', () => {
    const base = { projectResolved: true, isWorkspaceAdmin: false, canAccessAdminSettings: true };
    // Admin here and Owner here raise the admin rail; Member / Viewer / non-member do not,
    // even though the org-wide flag is true (they are Admin on some OTHER project).
    expect(resolveProjectSettingsRail({ ...base, myRole: 300 })).toBe('admin');
    expect(resolveProjectSettingsRail({ ...base, myRole: 400 })).toBe('admin');
    expect(resolveProjectSettingsRail({ ...base, myRole: 100 })).toBe('member');
    expect(resolveProjectSettingsRail({ ...base, myRole: 1 })).toBe('member');
    expect(resolveProjectSettingsRail({ ...base, myRole: null })).toBe('member');
    // A workspace admin with no membership still gets the admin rail.
    expect(resolveProjectSettingsRail({ ...base, isWorkspaceAdmin: true, myRole: null })).toBe(
      'admin',
    );
    // Unresolved project: its own state, never admin.
    expect(resolveProjectSettingsRail({ ...base, projectResolved: false, myRole: undefined })).toBe(
      'loading',
    );
    // Payload without my_role falls back to the org-wide flag.
    expect(resolveProjectSettingsRail({ ...base, myRole: undefined })).toBe('admin');
    expect(
      resolveProjectSettingsRail({ ...base, canAccessAdminSettings: undefined, myRole: undefined }),
    ).toBe('member');
  });

  it('withholds the full admin rail unless the rail resolves to admin (#3449, rule 379)', () => {
    expect(shouldShowProjectMemberRail('loading')).toBe(true);
    expect(shouldShowProjectMemberRail('member')).toBe(true);
    expect(shouldShowProjectMemberRail('admin')).toBe(false);
  });

  it('pins the two permission-affordance polarities against each other (rule 379(c))', () => {
    expect(canAuthorPlan(undefined)).toBe(false);
    expect(shouldShowProjectMemberRail('loading')).toBe(true);
    expect(canAuthorPlan(true)).toBe(true);
    expect(shouldShowProjectMemberRail('admin')).toBe(false);
  });

  describe('rendered ProjectSettingsPage', () => {
    it('renders the member rail while the project is still loading', () => {
      mockUser.user = { can_access_admin_settings: true };
      mockProject.data = undefined;
      renderPage();
      expect(screen.getAllByText('Your project').length).toBeGreaterThan(0);
      expect(screen.queryByText('How this team works')).toBeNull();
    });

    it('renders the member rail for a Member HERE who is Admin elsewhere (can_access_admin_settings true)', () => {
      mockUser.user = { can_access_admin_settings: true };
      mockProject.data = { name: 'B', my_role: 100 };
      renderPage();
      expect(screen.getAllByText('Your project').length).toBeGreaterThan(0);
      expect(screen.queryByText('How this team works')).toBeNull();
    });

    it('renders the full rail for an Admin on this project', () => {
      mockUser.user = { can_access_admin_settings: true };
      mockProject.data = { name: 'A', my_role: 300 };
      renderPage();
      expect(screen.getAllByText('How this team works').length).toBeGreaterThan(0);
    });

    it('renders the full rail for a workspace admin with no membership here', () => {
      mockUser.user = { can_access_admin_settings: true };
      mockWs.isAdmin = true;
      mockProject.data = { name: 'A', my_role: null };
      renderPage();
      expect(screen.getAllByText('How this team works').length).toBeGreaterThan(0);
    });
  });
});
