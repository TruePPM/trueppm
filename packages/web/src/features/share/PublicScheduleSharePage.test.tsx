import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PublicScheduleSharePage } from './PublicScheduleSharePage';
import type { PublicSchedule, PublicScheduleTask } from './scheduleShareApi';

const fetchMock = vi.hoisted(() => vi.fn());
const classifyMock = vi.hoisted(() => vi.fn());

vi.mock('./scheduleShareApi', () => ({
  fetchPublicSchedule: fetchMock,
  classifyShareError: classifyMock,
}));

// useNoReferrer mutates document-level referrer policy; irrelevant to render.
vi.mock('./useNoReferrer', () => ({ useNoReferrer: () => undefined }));

function renderAt(token = 'tok123') {
  return render(
    <MemoryRouter initialEntries={[`/share/schedule/${token}`]}>
      <Routes>
        <Route path="/share/schedule/:token" element={<PublicScheduleSharePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function task(overrides: Partial<PublicScheduleTask> = {}): PublicScheduleTask {
  return {
    short_id: 'RIV-1',
    name: 'Frame walls',
    wbs_path: '1',
    duration: 5,
    planned_start: '2026-08-01',
    early_start: '2026-08-01',
    early_finish: '2026-08-06',
    is_milestone: false,
    is_critical: true,
    percent_complete: 40,
    status: 'IN_PROGRESS',
    assignee: null,
    ...overrides,
  };
}

const schedule: PublicSchedule = {
  content_kind: 'schedule',
  project: { name: 'Riverside', short_id: 'RIV' },
  tasks: [task()],
  dependencies: [],
  show_assignees: false,
  truncated: false,
};

describe('PublicScheduleSharePage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the read-only schedule (golden path)', async () => {
    fetchMock.mockResolvedValueOnce(schedule);
    renderAt();
    expect(await screen.findByText('Frame walls')).toBeInTheDocument();
    expect(screen.getByText('Read-only shared view')).toBeInTheDocument();
    expect(screen.getByText(/Riverside — Schedule/)).toBeInTheDocument();
    expect(screen.getByText('Critical path (CP)')).toBeInTheDocument();
  });

  it('surfaces the MCP example prompts on the demo landing (#1847)', async () => {
    fetchMock.mockResolvedValueOnce(schedule);
    renderAt();
    await screen.findByText('Frame walls');
    expect(
      screen.getByRole('region', { name: /Explore this schedule with an AI assistant/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Ask this schedule anything')).toBeInTheDocument();
    expect(
      screen.getByText('What breaks if I slip the integration task 5 days?'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Connect an AI assistant/i })).toBeInTheDocument();
  });

  it('draws milestones in brand-accent amber, not brand-primary sage (#1684)', async () => {
    const milestone = task({
      short_id: 'RIV-2',
      name: 'Roof complete',
      wbs_path: '2',
      duration: 0,
      is_milestone: true,
      is_critical: false,
    });
    fetchMock.mockResolvedValueOnce({ ...schedule, tasks: [task(), milestone] });
    const { container } = renderAt();
    await screen.findByText('Roof complete');
    // The diamond marker uses the amber token, and no milestone diamond is sage.
    expect(container.querySelector('.bg-brand-accent.rotate-45')).not.toBeNull();
    // The legend gains a Milestone entry once a milestone is present.
    expect(screen.getByText('Milestone')).toBeInTheDocument();
  });

  it('renders the empty-schedule state', async () => {
    fetchMock.mockResolvedValueOnce({ ...schedule, tasks: [] });
    renderAt();
    await waitFor(() =>
      expect(screen.getByText('No scheduled tasks to show yet.')).toBeInTheDocument(),
    );
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
});
