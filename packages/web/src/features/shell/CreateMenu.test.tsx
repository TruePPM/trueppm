import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { useCreateIntentStore } from '@/stores/createIntentStore';
import { CreateMenu } from './CreateMenu';

const PID = '11111111-1111-1111-1111-111111111111';
const GID = '22222222-2222-2222-2222-222222222222';

// vi.hoisted runs before the PID/GID consts, so the factories use literals.
const projectId = vi.hoisted<{ current: string | undefined }>(() => ({
  current: '11111111-1111-1111-1111-111111111111',
}));
const programId = vi.hoisted<{ current: string | undefined }>(() => ({ current: undefined }));
const role = vi.hoisted<{ current: number | null }>(() => ({ current: 100 })); // MEMBER
const canBacklog = vi.hoisted<{ current: boolean }>(() => ({ current: true }));
const myRole = vi.hoisted<{ current: number | null }>(() => ({ current: 300 })); // program ADMIN

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => projectId.current }));
vi.mock('@/hooks/useProgramId', () => ({ useProgramId: () => programId.current }));
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: role.current, isLoading: false }),
}));
vi.mock('@/hooks/useMyFacets', () => ({ useCanManageBacklog: () => canBacklog.current }));
vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => ({ data: { id: GID, my_role: myRole.current }, isLoading: false }),
}));

function render(pathname: string) {
  return renderWithRouter(<CreateMenu />, { initialEntries: [pathname] });
}

beforeEach(() => {
  useCreateIntentStore.getState().close();
  projectId.current = PID;
  programId.current = undefined;
  role.current = 100;
  canBacklog.current = true;
  myRole.current = 300;
});

describe('CreateMenu (ADR-0130, #1179)', () => {
  it('board → a single "New task" button for a Member', () => {
    render(`/projects/${PID}/board`);
    expect(screen.getByRole('button', { name: 'New task' })).toBeInTheDocument();
  });

  it('clicking "New task" publishes a sprint-free task intent', async () => {
    const user = userEvent.setup();
    render(`/projects/${PID}/board`);
    await user.click(screen.getByRole('button', { name: 'New task' }));
    expect(useCreateIntentStore.getState().intent).toEqual({ kind: 'task', projectId: PID });
  });

  it('hidden for a Viewer (role 0) — no DOM node', () => {
    role.current = 0;
    const { container } = render(`/projects/${PID}/board`);
    expect(container.firstChild).toBeNull();
  });

  it('hidden while the role is still loading (null)', () => {
    role.current = null;
    const { container } = render(`/projects/${PID}/board`);
    expect(container.firstChild).toBeNull();
  });

  it('schedule → a menu offering Task and Milestone', async () => {
    const user = userEvent.setup();
    render(`/projects/${PID}/schedule`);
    await user.click(screen.getByRole('button', { name: 'Create new' }));
    expect(screen.getByRole('menuitem', { name: 'task' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'milestone' })).toBeInTheDocument();
  });

  it('choosing Milestone publishes an isMilestone task intent', async () => {
    const user = userEvent.setup();
    render(`/projects/${PID}/schedule`);
    await user.click(screen.getByRole('button', { name: 'Create new' }));
    await user.click(screen.getByRole('menuitem', { name: 'milestone' }));
    expect(useCreateIntentStore.getState().intent).toEqual({ kind: 'task', projectId: PID, isMilestone: true });
  });

  it('product-backlog → "New story" gated by useCanManageBacklog', async () => {
    const user = userEvent.setup();
    render(`/projects/${PID}/product-backlog`);
    await user.click(screen.getByRole('button', { name: 'New story' }));
    expect(useCreateIntentStore.getState().intent).toEqual({ kind: 'story', projectId: PID });
  });

  it('product-backlog hidden when the user cannot manage the backlog', () => {
    canBacklog.current = false;
    const { container } = render(`/projects/${PID}/product-backlog`);
    expect(container.firstChild).toBeNull();
  });

  it('program route → "New project" for a program admin', async () => {
    const user = userEvent.setup();
    projectId.current = undefined;
    programId.current = GID;
    render(`/programs/${GID}/overview`);
    await user.click(screen.getByRole('button', { name: 'New project' }));
    expect(useCreateIntentStore.getState().intent).toEqual({ kind: 'project', programId: GID });
  });

  it('program route hidden when the caller is not a program admin', () => {
    projectId.current = undefined;
    programId.current = GID;
    myRole.current = 100; // below ADMIN
    const { container } = render(`/programs/${GID}/overview`);
    expect(container.firstChild).toBeNull();
  });

  it('suppressed on overview / My Work (no target resolves)', () => {
    expect(render(`/projects/${PID}/overview`).container.firstChild).toBeNull();
    projectId.current = undefined;
    expect(render('/me/work').container.firstChild).toBeNull();
  });
});
