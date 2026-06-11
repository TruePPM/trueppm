import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ExternalLinksSection, StatusBadge } from './ExternalLinksSection';
import type { ExternalLinkStatus, TaskExternalLink } from '@/hooks/useTaskLinks';
import { ROLE_MEMBER, ROLE_VIEWER } from '@/lib/roles';

const useLinksMock = vi.hoisted(() => vi.fn());
const useCreateMock = vi.hoisted(() => vi.fn());
const useDeleteMock = vi.hoisted(() => vi.fn());
const useRefreshMock = vi.hoisted(() => vi.fn());
const useUpdateMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useTaskLinks', async () => {
  const actual =
    await vi.importActual<typeof import('@/hooks/useTaskLinks')>('@/hooks/useTaskLinks');
  return {
    ...actual,
    useTaskLinks: useLinksMock,
    useCreateTaskLink: useCreateMock,
    useDeleteTaskLink: useDeleteMock,
    useRefreshTaskLink: useRefreshMock,
    useUpdateTaskLink: useUpdateMock,
  };
});

function link(overrides: Partial<TaskExternalLink> = {}): TaskExternalLink {
  return {
    id: 'l1',
    url: 'https://gitlab.com/acme/api/-/merge_requests/5',
    provider: 'gitlab',
    title: 'MR 5',
    custom_title: '',
    labels: [],
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
    useUpdateMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
  });

  it('renders a safe http(s) link as a clickable anchor', () => {
    useLinksMock.mockReturnValue({
      links: [link({ title: 'MR 5', url: 'https://gitlab.com/acme/api/-/merge_requests/5' })],
      isLoading: false,
      error: null,
    });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    const anchor = screen.getByRole('link', { name: /MR 5/ });
    expect(anchor).toHaveAttribute('href', 'https://gitlab.com/acme/api/-/merge_requests/5');
  });

  it('does NOT render a clickable anchor for a javascript: URL', () => {
    useLinksMock.mockReturnValue({
      links: [link({ id: 'evil', title: 'Click me', url: 'javascript:alert(1)' })],
      isLoading: false,
      error: null,
    });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
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
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.queryByRole('link', { name: /Broken/ })).toBeNull();
    expect(screen.getByText('Broken')).toBeInTheDocument();
  });
});

describe('ExternalLinksSection — custom title & labels (#970)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCreateMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useDeleteMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
    useRefreshMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useUpdateMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
  });

  it('shows the user custom title in preference to the provider title', () => {
    useLinksMock.mockReturnValue({
      links: [link({ custom_title: 'Design spec', title: 'MR 5' })],
      isLoading: false,
      error: null,
    });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByRole('link', { name: /Design spec/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^MR 5/ })).toBeNull();
  });

  it('renders labels as chips', () => {
    useLinksMock.mockReturnValue({
      links: [link({ labels: ['spec', 'design'] })],
      isLoading: false,
      error: null,
    });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    const labelList = screen.getByRole('list', { name: 'Labels' });
    expect(within(labelList).getByText('spec')).toBeInTheDocument();
    expect(within(labelList).getByText('design')).toBeInTheDocument();
  });

  it('reveals title + label inputs once a (bare) URL is entered', () => {
    useLinksMock.mockReturnValue({ links: [], isLoading: false, error: null });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.queryByLabelText('Link title')).toBeNull();
    // A scheme-less URL still enables the affordance (#970).
    fireEvent.change(screen.getByLabelText('Add a link URL'), {
      target: { value: 'github.com/acme/api/pull/5' },
    });
    expect(screen.getByLabelText('Link title')).toBeInTheDocument();
    expect(screen.getByLabelText('Add a label')).toBeInTheDocument();
  });

  it('edits custom title via the inline editor and PATCHes (#970)', () => {
    const mutate = vi.fn();
    useUpdateMock.mockReturnValue({ mutate, isPending: false, isError: false });
    useLinksMock.mockReturnValue({
      links: [link({ custom_title: 'Old', labels: ['spec'] })],
      isLoading: false,
      error: null,
    });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit Old/ }));
    const titleInput = screen.getByLabelText<HTMLInputElement>('Link title');
    expect(titleInput.value).toBe('Old');
    fireEvent.change(titleInput, { target: { value: 'New name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        taskId: 't1',
        linkId: 'l1',
        customTitle: 'New name',
        labels: ['spec'],
      }),
      expect.anything(),
    );
  });
});

describe('ExternalLinksSection — role-gated write controls (#1046)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCreateMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useDeleteMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
    useRefreshMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useUpdateMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
    useLinksMock.mockReturnValue({
      links: [link({ id: 'l1', title: 'Spec', custom_title: '', url: 'https://x.test/1' })],
      isLoading: false,
      error: null,
    });
  });

  it('hides add / edit / delete controls from a Viewer', () => {
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_VIEWER} />);
    // The link itself still renders (read access) …
    expect(screen.getByRole('link', { name: /Spec/ })).toBeInTheDocument();
    // … but no write affordances.
    expect(screen.queryByPlaceholderText(/Paste a .*URL/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit Spec/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
  });

  it('hides write controls while the role is still loading (undefined)', () => {
    render(<ExternalLinksSection taskId="t1" projectId="p1" />);
    expect(screen.queryByPlaceholderText(/Paste a .*URL/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit Spec/ })).toBeNull();
  });

  it('shows the add control to a Member', () => {
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByRole('button', { name: /Edit Spec/ })).toBeInTheDocument();
  });
});
