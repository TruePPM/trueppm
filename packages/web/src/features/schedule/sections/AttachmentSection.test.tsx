import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { TaskAttachment } from '@/types';
import { AttachmentSection } from './AttachmentSection';
import { ROLE_MEMBER, ROLE_VIEWER } from '@/lib/roles';

const useListMock = vi.hoisted(() => vi.fn());
const useCreateMock = vi.hoisted(() => vi.fn());
const useDeleteMock = vi.hoisted(() => vi.fn());
const useSignedUrlMock = vi.hoisted(() => vi.fn());
const useProjectMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useTaskAttachments', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTaskAttachments')>(
    '@/hooks/useTaskAttachments',
  );
  return {
    ...actual,
    useTaskAttachments: useListMock,
    useCreateAttachment: useCreateMock,
    useDeleteAttachment: useDeleteMock,
    useSignedDownloadUrl: useSignedUrlMock,
  };
});

// AttachmentSection reads the project's resolved attachment policy (ADR-0153,
// #976). Default to uploads-on with a representative allow-list so existing
// upload/list tests behave as before; per-test overrides exercise the
// disabled / empty-allowlist states.
vi.mock('@/hooks/useProject', () => ({ useProject: useProjectMock }));

const ATTACHMENT_POLICY = {
  effective_attachments_enabled: true,
  effective_allowed_attachment_types: ['application/pdf', 'text/csv', 'image/png'],
};

function attachment(overrides: Partial<TaskAttachment> = {}): TaskAttachment {
  return {
    id: 'a1',
    file: 'a1.pdf',
    file_name: 'design.pdf',
    file_size: 1024,
    file_mime: 'application/pdf',
    external_url: '',
    external_title: '',
    is_pinned: false,
    uploaded_by: { id: 'u1', username: 'alice', display_name: 'Alice' },
    deleted_by: null,
    created_at: '2026-05-19T00:00:00Z',
    is_deleted: false,
    deleted_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useCreateMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
  useDeleteMock.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
  useSignedUrlMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useProjectMock.mockReturnValue({ data: ATTACHMENT_POLICY });
});

afterEach(() => {
  // Restore any per-test navigator.onLine spies so other test files don't see
  // a leaked non-configurable property.
  vi.restoreAllMocks();
});

describe('AttachmentSection — list states', () => {
  it('renders the loading skeleton', () => {
    useListMock.mockReturnValue({ attachments: [], isLoading: true, error: null });
    render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByLabelText('Loading attachments')).toBeTruthy();
  });

  it('renders the error state', () => {
    useListMock.mockReturnValue({
      attachments: [],
      isLoading: false,
      error: new Error('boom'),
    });
    render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load");
  });

  it('renders rows for each attachment, pinned first', () => {
    useListMock.mockReturnValue({
      attachments: [
        attachment({ id: 'a1', file_name: 'b.pdf', is_pinned: false }),
        attachment({ id: 'a2', file_name: 'pinned.pdf', is_pinned: true }),
      ],
      isLoading: false,
      error: null,
    });
    render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    const list = screen.getByLabelText(/Attachments — 2 total/);
    const items = list.querySelectorAll('li');
    expect(items[0].textContent).toContain('pinned.pdf');
    expect(items[1].textContent).toContain('b.pdf');
  });

  it('renders the empty-state drop zone (always visible) when list is empty', () => {
    useListMock.mockReturnValue({ attachments: [], isLoading: false, error: null });
    render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.queryByLabelText(/Attachments —/)).toBeNull();
    expect(screen.getByText(/Drop file here/)).toBeTruthy();
  });
});

describe('AttachmentSection — upload + delete actions', () => {
  it('passes a file picker selection through to useCreateAttachment', () => {
    const mutate = vi.fn();
    useCreateMock.mockReturnValue({ mutate, isPending: false, isError: false });
    useListMock.mockReturnValue({ attachments: [], isLoading: false, error: null });
    const { container } = render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', taskId: 't1', file }),
      expect.anything(),
    );
  });

  it('surfaces a client-side validation error for unsupported MIME types', () => {
    const mutate = vi.fn();
    useCreateMock.mockReturnValue({ mutate, isPending: false, isError: false });
    useListMock.mockReturnValue({ attachments: [], isLoading: false, error: null });
    const { container } = render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const bad = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.change(fileInput, { target: { files: [bad] } });
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/not allowed/i);
  });

  it('keeps the action buttons in a non-shrinking row, separate from status/error messages', () => {
    // Regression: a long validation error used to share the buttons' flex row and
    // shrink them, wrapping the labels to "+ Attach\nfile". Buttons must not wrap,
    // and the error must render outside the button row so it can never squeeze them.
    const mutate = vi.fn();
    useCreateMock.mockReturnValue({ mutate, isPending: false, isError: false });
    useListMock.mockReturnValue({ attachments: [], isLoading: false, error: null });
    const { container } = render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);

    const attachBtn = screen.getByText('+ Attach file');
    const pinBtn = screen.getByText('+ Pin link');
    expect(attachBtn.className).toContain('whitespace-nowrap');
    expect(pinBtn.className).toContain('whitespace-nowrap');
    expect(attachBtn.parentElement).toBe(pinBtn.parentElement);

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(fileInput, {
      target: { files: [new File(['x'], 'page.html', { type: 'text/html' })] },
    });
    expect(attachBtn.parentElement?.contains(screen.getByRole('alert'))).toBe(false);
  });

  it('opens the Pin link modal and forwards the submitted URL', () => {
    const mutate = vi.fn();
    useCreateMock.mockReturnValue({ mutate, isPending: false, isError: false });
    useListMock.mockReturnValue({ attachments: [], isLoading: false, error: null });
    const { container } = render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByText('+ Pin link'));
    const urlInput = container.querySelector<HTMLInputElement>('input[type="url"]')!;
    fireEvent.change(urlInput, { target: { value: 'https://figma.com/x' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        taskId: 't1',
        externalUrl: 'https://figma.com/x',
      }),
      expect.anything(),
    );
  });

  it('shows the two-step confirm flow for delete', () => {
    const mutate = vi.fn();
    useDeleteMock.mockReturnValue({ mutate, isPending: false, isError: false });
    useListMock.mockReturnValue({
      attachments: [attachment({ file_name: 'doomed.pdf' })],
      isLoading: false,
      error: null,
    });
    render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByLabelText('Delete doomed.pdf'));
    fireEvent.click(screen.getByLabelText('Confirm delete doomed.pdf'));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: 'a1' }),
      expect.anything(),
    );
  });

  it('opens the signed download URL on download click', () => {
    type Opts = { onSuccess?: (data: { url: string; expires_at: string }) => void };
    const mutate = vi.fn((_vars: unknown, opts?: Opts) => {
      opts?.onSuccess?.({ url: 'https://signed/x', expires_at: '2026' });
    });
    useSignedUrlMock.mockReturnValue({ mutate, isPending: false });
    useListMock.mockReturnValue({
      attachments: [attachment({ file_name: 'doc.pdf' })],
      isLoading: false,
      error: null,
    });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByLabelText('Download doc.pdf'));
    expect(openSpy).toHaveBeenCalledWith('https://signed/x', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  it('does not open a javascript: external URL and renders without crashing (#898)', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    useListMock.mockReturnValue({
      attachments: [
        attachment({
          file_name: '',
          file_mime: '',
          external_url: 'javascript:alert(1)',
          external_title: 'Evil link',
        }),
      ],
      isLoading: false,
      error: null,
    });
    render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByLabelText('Open Evil link'));
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('renders a row with a malformed external URL without throwing (#898)', () => {
    useListMock.mockReturnValue({
      attachments: [
        attachment({
          file_name: '',
          file_mime: '',
          external_url: 'http://[malformed',
          external_title: 'Bad host',
        }),
      ],
      isLoading: false,
      error: null,
    });
    // Would throw at `new URL(...).host` before the fix, crashing the render.
    render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByText('Bad host')).toBeInTheDocument();
    expect(screen.getByText(/external link/)).toBeInTheDocument();
  });

  it('opens external link in a new tab without minting a signed URL', () => {
    const mintMutate = vi.fn();
    useSignedUrlMock.mockReturnValue({ mutate: mintMutate, isPending: false });
    useListMock.mockReturnValue({
      attachments: [
        attachment({
          file_name: '',
          file_mime: '',
          external_url: 'https://docs.google.com/x',
          external_title: 'Design doc',
        }),
      ],
      isLoading: false,
      error: null,
    });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    fireEvent.click(screen.getByLabelText('Open Design doc'));
    expect(mintMutate).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(
      'https://docs.google.com/x',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });
});

describe('AttachmentSection — offline guard', () => {
  it('disables upload controls and shows the offline banner when offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    useListMock.mockReturnValue({ attachments: [], isLoading: false, error: null });
    render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByText('+ Attach file')).toBeDisabled();
    expect(screen.getByRole('status').textContent).toMatch(/offline/i);
  });

  it('updates the offline state on window online/offline events', () => {
    const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    useListMock.mockReturnValue({ attachments: [], isLoading: false, error: null });
    render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByText('+ Attach file')).not.toBeDisabled();
    act(() => {
      onLineSpy.mockReturnValue(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText('+ Attach file')).toBeDisabled();
    act(() => {
      onLineSpy.mockReturnValue(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByText('+ Attach file')).not.toBeDisabled();
  });
});

describe('AttachmentSection — role-gated write controls (#1046)', () => {
  beforeEach(() => {
    useListMock.mockReturnValue({
      attachments: [attachment({ id: 'a1', file_name: 'design.pdf' })],
      isLoading: false,
      error: null,
    });
  });

  it('hides upload, pin, and delete controls from a Viewer', () => {
    render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_VIEWER} />);
    // The attachment still lists (read/download access) …
    expect(screen.getByText('design.pdf')).toBeInTheDocument();
    // … but no write affordances.
    expect(screen.queryByText('+ Attach file')).toBeNull();
    expect(screen.queryByText('+ Pin link')).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete design.pdf/ })).toBeNull();
  });

  it('hides write controls while the role is still loading (undefined)', () => {
    render(<AttachmentSection taskId="t1" projectId="p1" />);
    expect(screen.queryByText('+ Attach file')).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete design.pdf/ })).toBeNull();
  });

  it('shows upload + delete controls to a Member', () => {
    render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);
    expect(screen.getByText('+ Attach file')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete design.pdf/ })).toBeInTheDocument();
  });
});

describe('AttachmentSection — policy-disabled state (#976)', () => {
  it('replaces the add-controls with a muted note when uploads are disabled, keeping existing files', () => {
    useProjectMock.mockReturnValue({
      data: { effective_attachments_enabled: false, effective_allowed_attachment_types: [] },
    });
    useListMock.mockReturnValue({
      attachments: [attachment({ file_name: 'kept.pdf' })],
      isLoading: false,
      error: null,
    });
    render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />);

    // Existing files still list + download.
    expect(screen.getByText('kept.pdf')).toBeInTheDocument();
    expect(screen.getByLabelText('Download kept.pdf')).toBeInTheDocument();
    // Add affordances are gone, replaced by the disabled note.
    expect(screen.queryByText('+ Attach file')).toBeNull();
    expect(screen.queryByText('+ Pin link')).toBeNull();
    const note = screen.getByRole('note');
    expect(note.textContent).toMatch(/File attachments are disabled for this project/);
  });

  it('does not show the disabled note to a Viewer (who had no add-controls anyway)', () => {
    useProjectMock.mockReturnValue({
      data: { effective_attachments_enabled: false, effective_allowed_attachment_types: [] },
    });
    useListMock.mockReturnValue({
      attachments: [attachment({ file_name: 'kept.pdf' })],
      isLoading: false,
      error: null,
    });
    render(<AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_VIEWER} />);
    expect(screen.getByText('kept.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('rejects an upload whose type is outside the resolved allow-list', () => {
    const mutate = vi.fn();
    useCreateMock.mockReturnValue({ mutate, isPending: false, isError: false });
    useProjectMock.mockReturnValue({
      data: {
        effective_attachments_enabled: true,
        // Only PDF is allowed — a PNG must be rejected client-side.
        effective_allowed_attachment_types: ['application/pdf'],
      },
    });
    useListMock.mockReturnValue({ attachments: [], isLoading: false, error: null });
    const { container } = render(
      <AttachmentSection taskId="t1" projectId="p1" userRole={ROLE_MEMBER} />,
    );
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(fileInput, {
      target: { files: [new File(['x'], 'pic.png', { type: 'image/png' })] },
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/not allowed/i);
  });
});
