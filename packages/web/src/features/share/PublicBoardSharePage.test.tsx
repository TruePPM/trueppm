import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PublicBoardSharePage } from './PublicBoardSharePage';
import type { PublicBoard } from './shareApi';

const fetchMock = vi.hoisted(() => vi.fn());
const classifyMock = vi.hoisted(() => vi.fn());

vi.mock('./shareApi', () => ({
  fetchPublicBoard: fetchMock,
  classifyShareError: classifyMock,
}));

const demoMode = vi.hoisted(() => ({ value: { isDemoReadOnly: false, isLoading: false } }));
vi.mock('@/hooks/useDemoMode', () => ({ useDemoMode: () => demoMode.value }));

function renderAt(token = 'tok123') {
  return render(
    <MemoryRouter initialEntries={[`/share/board/${token}`]}>
      <Routes>
        <Route path="/share/board/:token" element={<PublicBoardSharePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const board: PublicBoard = {
  content_kind: 'board',
  project: { name: 'Riverside', short_id: 'RIV' },
  columns: [
    {
      key: 'IN_PROGRESS',
      label: 'In Progress',
      cards: [
        {
          short_id: 'RIV-1',
          name: 'Frame walls',
          status: 'IN_PROGRESS',
          is_milestone: false,
          percent_complete: 40,
          due_date: '2026-08-01',
          assignee: null,
        },
      ],
    },
  ],
  show_assignees: false,
  truncated: false,
};

describe('PublicBoardSharePage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers the install link on a demo share link and not on a normal install (#4116)', async () => {
    fetchMock.mockResolvedValue(board);
    demoMode.value = { isDemoReadOnly: false, isLoading: false };
    const first = renderAt();
    await screen.findByText('Read-only shared view');
    expect(screen.queryByRole('link', { name: 'Install your own' })).toBeNull();
    first.unmount();

    demoMode.value = { isDemoReadOnly: true, isLoading: false };
    renderAt();
    const link = await screen.findByRole('link', { name: 'Install your own' });
    expect(link).toHaveAttribute('href', 'https://docs.trueppm.com/getting-started/installation/');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders the read-only board (golden path)', async () => {
    fetchMock.mockResolvedValueOnce(board);
    renderAt();
    expect(await screen.findByText('Frame walls')).toBeInTheDocument();
    expect(screen.getByText('Read-only shared view')).toBeInTheDocument();
    expect(screen.getByText('Riverside')).toBeInTheDocument();
  });

  it('shows the branded revoked/expired page on a 410', async () => {
    fetchMock.mockRejectedValueOnce(new Error('gone'));
    classifyMock.mockReturnValueOnce('revoked');
    renderAt();
    expect(await screen.findByText('This link is no longer active')).toBeInTheDocument();
  });

  it('shows the rate-limited page on a 429', async () => {
    fetchMock.mockRejectedValueOnce(new Error('throttled'));
    classifyMock.mockReturnValueOnce('rate_limited');
    renderAt();
    expect(await screen.findByText('Too many requests')).toBeInTheDocument();
  });

  it('shows the not-available page on a 404', async () => {
    fetchMock.mockRejectedValueOnce(new Error('nope'));
    classifyMock.mockReturnValueOnce('not_found');
    renderAt();
    expect(await screen.findByText("This share link isn't available")).toBeInTheDocument();
  });

  it('renders the empty-board state', async () => {
    fetchMock.mockResolvedValueOnce({ ...board, columns: [] });
    renderAt();
    await waitFor(() => expect(screen.getByText('No cards to show yet.')).toBeInTheDocument());
  });
});
