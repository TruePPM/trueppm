import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, it, expect, vi } from 'vitest';

import type { SprintRetroActionItem } from '@/hooks/useSprints';
import { RetroActionItems, type DraftActionItem } from './RetroActionItems';

function makePersisted(over: Partial<SprintRetroActionItem> = {}): SprintRetroActionItem {
  return {
    id: 'action-1',
    text: 'Automate the deploy step',
    assignee: null,
    assignee_username: null,
    story_points: 3,
    promoted_task_id: null,
    created_at: '2026-06-20T00:00:00Z',
    ...over,
  };
}

/**
 * RetroActionItems reads the active project from the URL via useProjectId(), so it
 * is mounted under a real `/projects/:projectId` route here — the shared
 * renderWithRouter helper uses a catch-all path that would not populate the param.
 */
function renderUnderProject(items: DraftActionItem[], persisted: SprintRetroActionItem[]) {
  const persistedByText = new Map(persisted.map((p) => [p.text, p]));
  const element = (
    <RetroActionItems
      items={items}
      persistedByText={persistedByText}
      savePending={false}
      promotePending={false}
      onAdd={vi.fn()}
      onUpdate={vi.fn()}
      onRemove={vi.fn()}
      onPromote={vi.fn()}
    />
  );
  const router = createMemoryRouter([{ path: '/projects/:projectId/sprints', element }], {
    initialEntries: ['/projects/proj-1/sprints'],
  });
  return render(<RouterProvider router={router} />);
}

describe('RetroActionItems', () => {
  it('links a promoted action item to the schedule view by project + task hash', () => {
    const promoted = makePersisted({ promoted_task_id: 'task-abc123' });
    renderUnderProject([{ text: promoted.text, story_points: '3' }], [promoted]);

    const link = screen.getByRole('link', { name: /T-task-a/i });
    // Regression (#1288): this was previously href="#task-..." — a dead in-page
    // anchor that navigated nowhere. It must be a real project-scoped route.
    expect(link).toHaveAttribute('href', '/projects/proj-1/schedule#task-task-abc123');
  });

  it('shows the Promote button for a saved-but-unpromoted item', () => {
    const saved = makePersisted({ promoted_task_id: null });
    renderUnderProject([{ text: saved.text, story_points: '3' }], [saved]);

    expect(
      screen.getByRole('button', { name: /Promote action item 1 to backlog/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows "Save first" for an unsaved draft item', () => {
    renderUnderProject([{ text: 'A brand new idea', story_points: '' }], []);

    expect(screen.getByText(/Save first/i)).toBeInTheDocument();
  });
});
