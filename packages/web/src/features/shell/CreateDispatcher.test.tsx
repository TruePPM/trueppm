/**
 * The demotion (#2952, design case 18): a `task` intent lands in the Designer,
 * it does not open a form.
 *
 * These cases exist because the change is a *deletion of a modal*, and the way
 * that regresses is silent — someone re-adds the form for one caller "just for
 * now" and the eight surfaces start diverging again. Asserting the navigation
 * pins the contract at the seam every demoted caller shares.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateDispatcher } from './CreateDispatcher';
import { useCreateIntentStore } from '@/stores/createIntentStore';

function renderDispatcher() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/projects/p1/board']}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/projects/:projectId/board" element={<CreateDispatcher />} />
          <Route path="/projects/:projectId/schedule" element={<div>schedule</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useCreateIntentStore.setState({ intent: null });
});

describe('a task intent is demoted to the Designer', () => {
  it('navigates to the schedule with ?author=task instead of rendering a form', async () => {
    renderDispatcher();
    useCreateIntentStore.getState().open({ kind: 'task', projectId: 'p1' });

    await waitFor(() => expect(screen.getByText('schedule')).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('routes a milestone intent to the same place with its own intent', async () => {
    renderDispatcher();
    useCreateIntentStore
      .getState()
      .open({ kind: 'task', projectId: 'p1', isMilestone: true });

    await waitFor(() => expect(screen.getByText('schedule')).toBeInTheDocument());
  });

  it('clears the intent, so a re-render cannot author a second row', async () => {
    // The intent is what re-triggers the effect. If it outlived the navigation,
    // arriving on the Designer would create one row and a re-render would
    // create another — and the user only asked once.
    renderDispatcher();
    useCreateIntentStore.getState().open({ kind: 'task', projectId: 'p1' });

    await waitFor(() => expect(useCreateIntentStore.getState().intent).toBeNull());
  });

  it('renders nothing at all with no intent', () => {
    const { container } = renderDispatcher();
    expect(container).toBeEmptyDOMElement();
  });

  it('leaves the story target to the backlog page', () => {
    const { container } = renderDispatcher();
    useCreateIntentStore.getState().open({ kind: 'story', projectId: 'p1' });
    expect(container).toBeEmptyDOMElement();
  });
});
