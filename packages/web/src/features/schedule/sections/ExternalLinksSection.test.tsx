import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ExternalLinksSection } from './ExternalLinksSection';
// StatusBadge was lifted into a shared module (#971) so the Assets surface reuses it.
import { StatusBadge } from '@/components/linkPresentation';
import type { ExternalLinkStatus, TaskExternalLink } from '@/hooks/useTaskLinks';
import { ROLE_MEMBER, ROLE_VIEWER } from '@/lib/roles';

// Shape of the `mutate(vars, opts)` call the section drives — a typed signature
// so the per-test success/error callbacks are checked rather than `any`.
type LinkMutate = (
  vars: unknown,
  opts: { onSuccess: () => void; onError: (error: unknown) => void },
) => void;

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
    description: '',
    thumbnail_url: '',
    preview_type: '',
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

describe('ExternalLinksSection — cloud-file preview (#571)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCreateMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useDeleteMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
    useRefreshMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useUpdateMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
  });

  function fileLink(overrides: Partial<TaskExternalLink> = {}): TaskExternalLink {
    return link({
      id: 'f1',
      provider: 'google_drive',
      url: 'https://docs.google.com/spreadsheets/d/abc/edit',
      title: 'Q3 Budget',
      status: 'unknown',
      ...overrides,
    });
  }

  it('shows a preview-type chip — not a status pill — for a refreshed file link', () => {
    useLinksMock.mockReturnValue({
      links: [fileLink({ preview_type: 'spreadsheet', description: 'Quarterly projections' })],
      isLoading: false,
      error: null,
    });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByLabelText('File type: Spreadsheet')).toBeInTheDocument();
    // A file has no lifecycle — the "UNKNOWN" git status pill must not render.
    expect(screen.queryByText('UNKNOWN')).toBeNull();
    expect(screen.getByText('Quarterly projections')).toBeInTheDocument();
  });

  it('renders the thumbnail as a decorative image when present', () => {
    useLinksMock.mockReturnValue({
      links: [
        fileLink({
          preview_type: 'image',
          thumbnail_url: 'https://cdn.example.com/t.png',
          description: 'A diagram',
        }),
      ],
      isLoading: false,
      error: null,
    });
    const { container } = render(
      <ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', 'https://cdn.example.com/t.png');
    // Decorative — the title + description carry the meaning.
    expect(img).toHaveAttribute('alt', '');
  });

  it('shows no chip and no preview block for a file link not yet refreshed', () => {
    useLinksMock.mockReturnValue({
      links: [fileLink({ title: '', preview_type: '', description: '', thumbnail_url: '' })],
      isLoading: false,
      error: null,
    });
    const { container } = render(
      <ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />,
    );
    // No type chip yet (refresh is the call to action) and no status pill.
    expect(screen.queryByText(/File type:/)).toBeNull();
    expect(screen.queryByText('UNKNOWN')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('falls back to a type glyph when the file link has no thumbnail', () => {
    useLinksMock.mockReturnValue({
      links: [fileLink({ preview_type: 'document', description: 'A spec', thumbnail_url: '' })],
      isLoading: false,
      error: null,
    });
    const { container } = render(
      <ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />,
    );
    // No <img>, but the description (and the glyph placeholder) render.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('A spec')).toBeInTheDocument();
    expect(screen.getByLabelText('File type: Document')).toBeInTheDocument();
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

function baseMocks() {
  useCreateMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useDeleteMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
  useRefreshMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useUpdateMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
}

describe('ExternalLinksSection — loading / error / empty states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseMocks();
  });

  it('renders skeleton placeholders while links load', () => {
    useLinksMock.mockReturnValue({ links: [], isLoading: true, error: null });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByLabelText('Loading links')).toBeInTheDocument();
    // Add control is suppressed while loading.
    expect(screen.queryByLabelText('Add a link URL')).toBeNull();
  });

  it('renders an error alert when the links query fails', () => {
    useLinksMock.mockReturnValue({ links: [], isLoading: false, error: new Error('boom') });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load links.");
    expect(screen.queryByLabelText('Add a link URL')).toBeNull();
  });

  it('shows the empty-state note plus the add control for an editor', () => {
    useLinksMock.mockReturnValue({ links: [], isLoading: false, error: null });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByRole('note')).toBeInTheDocument();
    expect(screen.getByLabelText('Add a link URL')).toBeInTheDocument();
  });

  it('labels the list with its total count', () => {
    useLinksMock.mockReturnValue({
      links: [link({ id: 'a' }), link({ id: 'b' })],
      isLoading: false,
      error: null,
    });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByRole('list', { name: 'External links — 2 total' })).toBeInTheDocument();
  });
});

describe('ExternalLinksSection — add-link input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseMocks();
    useLinksMock.mockReturnValue({ links: [], isLoading: false, error: null });
  });

  it('keeps the Add button disabled until a valid URL is detected', () => {
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    const addBtn = screen.getByRole('button', { name: 'Add' });
    expect(addBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Add a link URL'), {
      target: { value: 'github.com/acme/api/pull/5' },
    });
    expect(addBtn).toBeEnabled();
  });

  it.each<[string, string]>([
    ['github.com/acme/api/pull/5', '🐙 GitHub detected · refresh fetches live status'],
    ['gitlab.com/acme/api/-/merge_requests/5', '🦊 GitLab detected · refresh fetches live status'],
    ['drive.google.com/file/d/abc', '📂 Google Drive detected · refresh loads a preview'],
    ['example.com/whatever', '🔗 Saved as a generic link (no live status)'],
  ])('shows the provider hint for %s', (url, hint) => {
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.change(screen.getByLabelText('Add a link URL'), { target: { value: url } });
    expect(screen.getByText(hint)).toBeInTheDocument();
  });

  it('submits a detected URL and resets the fields on success', () => {
    const mutate = vi.fn<LinkMutate>((_vars, opts) => opts.onSuccess());
    useCreateMock.mockReturnValue({ mutate, isPending: false });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    const urlInput = screen.getByLabelText<HTMLInputElement>('Add a link URL');
    fireEvent.change(urlInput, { target: { value: 'github.com/acme/api/pull/5' } });
    fireEvent.change(screen.getByLabelText('Link title'), { target: { value: 'Fix' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        taskId: 't1',
        url: 'github.com/acme/api/pull/5',
        customTitle: 'Fix',
      }),
      expect.anything(),
    );
    expect(urlInput.value).toBe('');
  });

  it('submits on Enter in the URL field', () => {
    const mutate = vi.fn();
    useCreateMock.mockReturnValue({ mutate, isPending: false });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    const urlInput = screen.getByLabelText('Add a link URL');
    fireEvent.change(urlInput, { target: { value: 'github.com/acme/api/pull/5' } });
    fireEvent.keyDown(urlInput, { key: 'Enter' });
    expect(mutate).toHaveBeenCalled();
  });

  it('surfaces a create error message', () => {
    const mutate = vi.fn<LinkMutate>((_vars, opts) => opts.onError(new Error('duplicate link')));
    useCreateMock.mockReturnValue({ mutate, isPending: false });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.change(screen.getByLabelText('Add a link URL'), {
      target: { value: 'github.com/acme/api/pull/5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('duplicate link');
  });

  it('does nothing when Add is clicked with no detected URL', () => {
    const mutate = vi.fn();
    useCreateMock.mockReturnValue({ mutate, isPending: false });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    // Enter in an empty field — handleSubmit early-returns (no detected provider).
    fireEvent.keyDown(screen.getByLabelText('Add a link URL'), { key: 'Enter' });
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('ExternalLinksSection — refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseMocks();
    useLinksMock.mockReturnValue({
      links: [link({ id: 'l1', title: 'MR 5', provider: 'github', url: 'https://github.com/a/b/pull/5' })],
      isLoading: false,
      error: null,
    });
  });

  it('calls the refresh mutation for the row', () => {
    const mutate = vi.fn();
    useRefreshMock.mockReturnValue({ mutate, isPending: false });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByRole('button', { name: /Refresh status for MR 5/ }));
    expect(mutate).toHaveBeenCalledWith(
      { projectId: 'p1', taskId: 't1', linkId: 'l1' },
      expect.anything(),
    );
  });

  it('offers a Connect shortcut when refresh needs a credential (422)', () => {
    const mutate = vi.fn<LinkMutate>((_vars, opts) =>
      opts.onError({ response: { data: { code: 'credential_required', provider: 'github' } } }),
    );
    useRefreshMock.mockReturnValue({ mutate, isPending: false });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByRole('button', { name: /Refresh status for MR 5/ }));
    const connect = screen.getByRole('link', { name: /Connect github to see status/ });
    expect(connect).toHaveAttribute('href', '/me/settings/connected-accounts#github');
  });

  it('shows a retry message on a generic refresh failure', () => {
    const mutate = vi.fn<LinkMutate>((_vars, opts) => opts.onError({ response: { data: {} } }));
    useRefreshMock.mockReturnValue({ mutate, isPending: false });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByRole('button', { name: /Refresh status for MR 5/ }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn.t refresh/);
    // The credential shortcut is NOT shown for a plain failure.
    expect(screen.queryByRole('link', { name: /Connect/ })).toBeNull();
  });

  it('disables the refresh button while a refresh is pending', () => {
    useRefreshMock.mockReturnValue({ mutate: vi.fn(), isPending: true });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByRole('button', { name: /Refresh status for MR 5/ })).toBeDisabled();
  });
});

describe('ExternalLinksSection — delete confirm flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseMocks();
    useLinksMock.mockReturnValue({
      links: [link({ id: 'l1', title: 'MR 5' })],
      isLoading: false,
      error: null,
    });
  });

  it('requires a two-step confirm before deleting', () => {
    const mutate = vi.fn();
    useDeleteMock.mockReturnValue({ mutate, isPending: false, isError: false });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    // First click reveals Confirm/Cancel; it does NOT delete yet.
    fireEvent.click(screen.getByRole('button', { name: /Delete MR 5/ }));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Confirm delete MR 5/ }));
    expect(mutate).toHaveBeenCalledWith(
      { projectId: 'p1', taskId: 't1', linkId: 'l1' },
      expect.anything(),
    );
  });

  it('cancels the delete confirmation without deleting', () => {
    const mutate = vi.fn();
    useDeleteMock.mockReturnValue({ mutate, isPending: false, isError: false });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete MR 5/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // Back to the single Delete affordance, nothing deleted.
    expect(screen.getByRole('button', { name: /Delete MR 5/ })).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('shows a failure message when delete errors', () => {
    useDeleteMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: true });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Delete failed.');
  });
});

describe('ExternalLinksSection — inline edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseMocks();
    useLinksMock.mockReturnValue({
      links: [link({ id: 'l1', title: 'MR 5', custom_title: 'Old', labels: ['spec'] })],
      isLoading: false,
      error: null,
    });
  });

  it('returns to the read view when edit is cancelled', () => {
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit Old/ }));
    expect(screen.getByLabelText('Link title')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Link title')).toBeNull();
    expect(screen.getByRole('link', { name: /Old/ })).toBeInTheDocument();
  });

  it('shows a save-failed alert when the update mutation errors', () => {
    useUpdateMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: true });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit Old/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Save failed.');
  });

  it('disables Save and shows a saving label while the update is pending', () => {
    useUpdateMock.mockReturnValue({ mutate: vi.fn(), isPending: true, isError: false });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit Old/ }));
    const save = screen.getByRole('button', { name: 'Saving…' });
    expect(save).toBeDisabled();
  });
});

describe('ExternalLinksSection — LabelChipInput (via edit mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseMocks();
  });

  function editLink(labels: string[]) {
    useLinksMock.mockReturnValue({
      links: [link({ id: 'l1', title: 'MR 5', custom_title: 'Old', labels })],
      isLoading: false,
      error: null,
    });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit Old/ }));
  }

  it('adds a chip on Enter and includes it in the saved payload', () => {
    const mutate = vi.fn();
    useUpdateMock.mockReturnValue({ mutate, isPending: false, isError: false });
    editLink(['spec']);
    const input = screen.getByLabelText('Add a label');
    fireEvent.change(input, { target: { value: 'design' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['spec', 'design'] }),
      expect.anything(),
    );
  });

  it('removes a chip via its remove button', () => {
    editLink(['spec', 'design']);
    expect(screen.getByText('spec')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove label spec' }));
    expect(screen.queryByText('spec')).toBeNull();
    expect(screen.getByText('design')).toBeInTheDocument();
  });

  it('removes the last chip on Backspace in an empty draft', () => {
    editLink(['spec', 'design']);
    fireEvent.keyDown(screen.getByLabelText('Add a label'), { key: 'Backspace' });
    expect(screen.queryByText('design')).toBeNull();
    expect(screen.getByText('spec')).toBeInTheDocument();
  });

  it('de-dupes case-insensitively', () => {
    editLink(['spec']);
    const input = screen.getByLabelText('Add a label');
    fireEvent.change(input, { target: { value: 'SPEC' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Still exactly one "spec" chip.
    expect(screen.getAllByText('spec')).toHaveLength(1);
  });

  it('disables the input and shows the cap placeholder at 12 labels', () => {
    editLink(Array.from({ length: 12 }, (_, i) => `l${i}`));
    const input = screen.getByLabelText<HTMLInputElement>('Add a label');
    expect(input).toBeDisabled();
    expect(input.placeholder).toBe('Label limit reached');
  });
});

describe('ExternalLinksSection — meta line short ref', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseMocks();
  });

  it.each<[string, RegExp]>([
    ['https://gitlab.com/a/b/-/merge_requests/42', /!42/],
    ['https://github.com/a/b/pull/7', /#7/],
    ['https://github.com/a/b/issues/9', /#9/],
    ['https://example.com/some/path', /example\.com/],
  ])('renders the short ref for %s', (url, ref) => {
    useLinksMock.mockReturnValue({
      links: [link({ id: 'l1', title: 'T', url, provider: 'gitlab' })],
      isLoading: false,
      error: null,
    });
    render(<ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByText(ref)).toBeInTheDocument();
  });
});

describe('ExternalLinksSection — file preview image fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseMocks();
  });

  it('falls back to the glyph when the thumbnail image fails to load', () => {
    useLinksMock.mockReturnValue({
      links: [
        link({
          id: 'f1',
          provider: 'google_drive',
          url: 'https://docs.google.com/document/d/abc/edit',
          title: 'Doc',
          status: 'unknown',
          preview_type: 'document',
          thumbnail_url: 'https://cdn.example.com/broken.png',
          description: 'A doc',
        }),
      ],
      isLoading: false,
      error: null,
    });
    const { container } = render(
      <ExternalLinksSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    // Simulate a load failure (offline / private file) — the img is dropped for the glyph.
    fireEvent.error(img!);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByLabelText('File type: Document')).toBeInTheDocument();
  });
});
