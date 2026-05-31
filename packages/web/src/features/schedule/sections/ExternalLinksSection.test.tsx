import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ExternalLinksSection, StatusBadge } from './ExternalLinksSection';
import type { ExternalLinkStatus, TaskExternalLink } from '@/hooks/useTaskLinks';

const useLinksMock = vi.hoisted(() => vi.fn());
const useCreateMock = vi.hoisted(() => vi.fn());
const useDeleteMock = vi.hoisted(() => vi.fn());
const useRefreshMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useTaskLinks', async () => {
  const actual =
    await vi.importActual<typeof import('@/hooks/useTaskLinks')>('@/hooks/useTaskLinks');
  return {
    ...actual,
    useTaskLinks: useLinksMock,
    useCreateTaskLink: useCreateMock,
    useDeleteTaskLink: useDeleteMock,
    useRefreshTaskLink: useRefreshMock,
  };
});

function link(overrides: Partial<TaskExternalLink> = {}): TaskExternalLink {
  return {
    id: 'l1',
    url: 'https://gitlab.com/acme/api/-/merge_requests/5',
    provider: 'gitlab',
    title: 'MR 5',
    status: 'open',
    fetched_at: null,
    display_order: 0,
    server_version: 1,
    ...overrides,
  };
}

describe('StatusBadge', () => {
  it.each<[ExternalLinkStatus, string]>([
    ['open', 'OPEN'],
    ['draft', 'DRAFT'],
    ['merged', 'MERGED'],
    ['closed', 'CLOSED'],
    ['unknown', 'UNKNOWN'],
  ])('renders the uppercase %s label (not color alone)', (status, label) => {
    render(<StatusBadge status={status} provider="github" />);
    expect(screen.getByText(label)).toBeInTheDocument();
    // The accessible name carries the status for screen readers.
    expect(screen.getByLabelText(`Status: ${status}`)).toBeInTheDocument();
  });

  it('shows an em dash for a generic link (status not applicable)', () => {
    render(<StatusBadge status="unknown" provider="generic" />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByLabelText('Status: not applicable')).toBeInTheDocument();
  });

  it('still shows UNKNOWN for a git provider awaiting refresh', () => {
    render(<StatusBadge status="unknown" provider="gitlab" />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
  });
});

describe('ExternalLinksSection — unsafe URL rendering (#898)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCreateMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useDeleteMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
    useRefreshMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  it('renders a safe http(s) link as a clickable anchor', () => {
    useLinksMock.mockReturnValue({
      links: [link({ title: 'MR 5', url: 'https://gitlab.com/acme/api/-/merge_requests/5' })],
      isLoading: false,
      error: null,
    });
    render(<ExternalLinksSection taskId="t1" projectId="p1" />);
    const anchor = screen.getByRole('link', { name: /MR 5/ });
    expect(anchor).toHaveAttribute('href', 'https://gitlab.com/acme/api/-/merge_requests/5');
  });

  it('does NOT render a clickable anchor for a javascript: URL', () => {
    useLinksMock.mockReturnValue({
      links: [link({ id: 'evil', title: 'Click me', url: 'javascript:alert(1)' })],
      isLoading: false,
      error: null,
    });
    render(<ExternalLinksSection taskId="t1" projectId="p1" />);
    // No anchor is rendered for the malicious link…
    expect(screen.queryByRole('link', { name: /Click me/ })).toBeNull();
    // …the title is still shown as inert text so the row isn't blank.
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('does NOT render a clickable anchor for a malformed URL', () => {
    useLinksMock.mockReturnValue({
      links: [link({ id: 'bad', title: 'Broken', url: 'not a url' })],
      isLoading: false,
      error: null,
    });
    render(<ExternalLinksSection taskId="t1" projectId="p1" />);
    expect(screen.queryByRole('link', { name: /Broken/ })).toBeNull();
    expect(screen.getByText('Broken')).toBeInTheDocument();
  });
});
