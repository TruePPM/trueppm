import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { setFeatureFlag } from '@/lib/featureFlags';
import { SHELL_V2_FLAG } from './ShellGate';
import { KitPage } from './KitPage';

const projectId = vi.hoisted(() => ({ current: undefined as string | undefined }));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => projectId.current }));

describe('KitPage', () => {
  beforeEach(() => {
    localStorage.clear();
    projectId.current = undefined;
    setFeatureFlag(SHELL_V2_FLAG, true);
  });

  it('composes every state section under one H1 when standalone', () => {
    renderWithRouter(<KitPage />, { initialEntries: ['/shell2/kit'] });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Page kit' })).toBeVisible();
    for (const name of [
      'Title scale',
      'Status chips',
      'Avatars',
      'Table',
      'Loading',
      'Empty',
      'Error',
    ]) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    const table = screen.getByRole('table', { name: 'Fixture tasks' });
    expect(within(table).getByText('Cut over payments API')).toBeInTheDocument();
    expect(screen.getByText('No risks logged yet')).toBeInTheDocument();
    expect(screen.getByText("The risk register couldn't load.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument();
  });

  it('hides the page title visually when mounted under a project context', () => {
    projectId.current = 'p-1';
    renderWithRouter(<KitPage />, { initialEntries: ['/projects/p-1/shell2-kit'] });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('table', { name: 'Fixture tasks' })).toBeInTheDocument();
  });

  it('replaces the toolbar with the filters-applied row when ?filtered=1', () => {
    renderWithRouter(<KitPage />, { initialEntries: ['/shell2/kit?filtered=1'] });
    expect(screen.getByText('2 filters applied')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Filter' })).not.toBeInTheDocument();
  });

  it('renders the bleed frame for ?width=bleed', () => {
    renderWithRouter(<KitPage />, { initialEntries: ['/shell2/kit?width=bleed'] });
    expect(screen.getByRole('table', { name: 'Fixture tasks' })).toBeInTheDocument();
  });

  it('sends the person home when the flag is off', () => {
    setFeatureFlag(SHELL_V2_FLAG, false);
    renderWithRouter(<KitPage />, { initialEntries: ['/shell2/kit'] });
    expect(screen.queryByRole('heading', { name: 'Page kit' })).not.toBeInTheDocument();
  });
});
