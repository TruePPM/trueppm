import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { WorkspaceRolesPage, buildRolesMatrixCsv } from './WorkspaceRolesPage';

// Mock the edition hook so the page renders without a QueryClientProvider and
// so each test can pick the running edition. Defaults to community.
vi.mock('@/hooks/useEdition', () => ({
  useEdition: vi.fn(() => ({ edition: 'community', isLoading: false })),
}));
import { useEdition } from '@/hooks/useEdition';
const mockUseEdition = useEdition as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockUseEdition.mockReturnValue({ edition: 'community', isLoading: false });
});

describe('buildRolesMatrixCsv', () => {
  it('serializes the capability matrix with a header and Yes/No grants', () => {
    const csv = buildRolesMatrixCsv();
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Section,Capability,Viewer,Member,Scheduler,Admin,Owner');
    // "View tasks" is granted to every role.
    expect(csv).toContain('Tasks,View tasks,Yes,Yes,Yes,Yes,Yes');
    // "Edit any task" is Admin + Owner only.
    expect(csv).toContain('Tasks,Edit any task,No,No,No,Yes,Yes');
  });
});

describe('WorkspaceRolesPage', () => {
  // Captured so assertions reference the local mock, not URL.createObjectURL
  // as an unbound method (eslint @typescript-eslint/unbound-method).
  // Vitest 4 narrows `vi.fn()` to `Mock<Procedure | Constructable>`, which no longer
  // assigns to URL.createObjectURL's `(obj) => string` signature — type the mock.
  let createObjectURL: Mock<(obj: Blob | MediaSource) => string>;

  beforeEach(() => {
    // jsdom implements neither createObjectURL nor anchor navigation; stub both.
    createObjectURL = vi.fn((_obj: Blob | MediaSource) => 'blob:mock');
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the Export matrix button enabled', () => {
    render(<WorkspaceRolesPage />);
    expect(screen.getByRole('button', { name: 'Export matrix' })).toBeEnabled();
  });

  it('exports a CSV blob when Export matrix is clicked (#594)', () => {
    render(<WorkspaceRolesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Export matrix' }));
    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toContain('text/csv');
  });
});

describe('WorkspaceRolesPage — Enterprise upsell (#541)', () => {
  // Basic OIDC/OAuth SSO and workspace data export ship in the OSS core, so
  // "Manage SSO" and "Export workspace data" are NOT badged (#2165). The
  // remaining Enterprise-only workspace capabilities keep their badge.
  const EE_ROWS = ['View audit log', 'Manage integrations', 'Manage billing'];

  it('renders an EE badge on every Enterprise-only matrix row in the community edition', () => {
    render(<WorkspaceRolesPage />);
    // Scope to the matrix — the custom-roles upsell caption (#1649) carries its
    // own EE badge outside the matrix, so a whole-document count would be one more.
    const matrix = screen.getByTestId('roles-matrix');
    const badges = within(matrix).getAllByRole('link', {
      name: /Available in TruePPM Enterprise/i,
    });
    expect(badges).toHaveLength(EE_ROWS.length);
  });

  it('does not badge Manage SSO — basic OIDC/OAuth SSO is OSS (#2165)', () => {
    render(<WorkspaceRolesPage />);
    // The "Manage SSO" row header must carry no Enterprise upsell link — the
    // shipped WorkspaceSsoPage is fully functional in the community edition.
    const ssoRowHeader = screen.getByRole('rowheader', { name: /Manage SSO/i });
    expect(within(ssoRowHeader).queryByRole('link')).toBeNull();
    // "Export workspace data" is OSS too — no badge.
    const exportRowHeader = screen.getByRole('rowheader', { name: /Export workspace data/i });
    expect(within(exportRowHeader).queryByRole('link')).toBeNull();
  });

  it('points each EE badge at the Enterprise page (no dead cells)', () => {
    render(<WorkspaceRolesPage />);
    const badges = screen.getAllByRole('link', { name: /Available in TruePPM Enterprise/i });
    // Matrix rows (3) + the custom-roles caption (1).
    expect(badges).toHaveLength(EE_ROWS.length + 1);
    for (const badge of badges) {
      expect(badge).toHaveAttribute('href', 'https://trueppm.com/enterprise');
      expect(badge).toHaveTextContent('EE');
    }
  });

  it('hides EE badges under the enterprise edition (the features are available)', () => {
    mockUseEdition.mockReturnValue({ edition: 'enterprise', isLoading: false });
    render(<WorkspaceRolesPage />);
    expect(screen.queryByRole('link', { name: /Available in TruePPM Enterprise/i })).toBeNull();
  });

  it('does not badge non-Enterprise capabilities', () => {
    render(<WorkspaceRolesPage />);
    // "View tasks" (granted to everyone) is OSS — its row must not carry a badge.
    const viewTasks = screen.getByText('View tasks');
    expect(viewTasks.querySelector('a')).toBeNull();
    // Exactly the five Workspace-section rows are badged inside the matrix.
    const matrix = screen.getByTestId('roles-matrix');
    expect(
      within(matrix).getAllByRole('link', { name: /Available in TruePPM Enterprise/i }),
    ).toHaveLength(EE_ROWS.length);
  });
});

describe('WorkspaceRolesPage — no fabricated member counts (#2165)', () => {
  it('renders no hardcoded "{n} people" count on the role cards', () => {
    render(<WorkspaceRolesPage />);
    // The old cards rendered static fiction (18/32/12/6/2 "people"). No count
    // source exists, so the count line is dropped entirely.
    expect(screen.queryByText(/\d+\s+people/)).toBeNull();
    for (const n of ['18', '32', '12', '6', '2']) {
      expect(screen.queryByText(`${n} people`)).toBeNull();
    }
  });
});

describe('WorkspaceRolesPage — accessible table semantics, WCAG 1.3.1 (#2165)', () => {
  it('renders the matrix as a table with a column header per role', () => {
    render(<WorkspaceRolesPage />);
    const matrix = screen.getByTestId('roles-matrix');
    expect(within(matrix).getByRole('table')).toBeInTheDocument();
    // One column header for the capability column plus one per role.
    for (const role of ['Viewer', 'Member', 'Scheduler', 'Admin', 'Owner']) {
      expect(within(matrix).getByRole('columnheader', { name: role })).toBeInTheDocument();
    }
    expect(within(matrix).getByRole('columnheader', { name: 'Capability' })).toBeInTheDocument();
  });

  it('exposes each capability as a row header (scope="row")', () => {
    render(<WorkspaceRolesPage />);
    const matrix = screen.getByTestId('roles-matrix');
    expect(within(matrix).getByRole('rowheader', { name: 'View tasks' })).toBeInTheDocument();
    expect(
      within(matrix).getByRole('rowheader', { name: /Edit working calendar/ }),
    ).toBeInTheDocument();
  });

  it('conveys each grant cell state as text tied to the row and column', () => {
    render(<WorkspaceRolesPage />);
    const matrix = screen.getByTestId('roles-matrix');
    // Every grant cell carries a visually-hidden Granted/Not granted label; the
    // 5-column × many-row matrix yields both states.
    expect(within(matrix).getAllByText('Granted').length).toBeGreaterThan(0);
    expect(within(matrix).getAllByText('Not granted').length).toBeGreaterThan(0);
  });
});

describe('WorkspaceRolesPage — gate reconciliation with the server matrix (#2165)', () => {
  it('gates working-calendar edits at Scheduler+ (not Admin+)', () => {
    // Scheduler column (index 2) must be granted for "Edit working calendar".
    const csv = buildRolesMatrixCsv();
    expect(csv).toContain('Schedule,Edit working calendar,No,No,Yes,Yes,Yes');
  });

  it('surfaces the ADR-0041 Scheduler-writable methodology/estimation split', () => {
    const csv = buildRolesMatrixCsv();
    expect(csv).toContain('Project,Set methodology & estimation mode,No,No,Yes,Yes,Yes');
  });

  it('gates resource-heatmap reads at Scheduler+ (not Member+)', () => {
    const csv = buildRolesMatrixCsv();
    expect(csv).toContain('People,View resource heatmap,No,No,Yes,Yes,Yes');
  });
});

describe('WorkspaceRolesPage — read-only reference framing (#1649)', () => {
  it('renders no stub preview banner', () => {
    render(<WorkspaceRolesPage />);
    expect(screen.queryByTestId('stub-page-banner')).toBeNull();
  });

  it('shows no "changes will not be saved" preview copy', () => {
    render(<WorkspaceRolesPage />);
    expect(screen.queryByText(/changes will not be saved/i)).toBeNull();
    expect(screen.queryByText(/preview/i)).toBeNull();
  });

  it('frames the matrix as a read-only reference', () => {
    render(<WorkspaceRolesPage />);
    expect(screen.getByText(/read-only reference/i)).toBeInTheDocument();
  });

  it('surfaces a reachable custom-roles Enterprise upsell in the community edition', () => {
    render(<WorkspaceRolesPage />);
    expect(screen.getByText(/Need custom roles/i)).toBeInTheDocument();
    // The upsell badge lives outside the matrix and is a real link, not a tooltip.
    const matrix = screen.getByTestId('roles-matrix');
    const allBadges = screen.getAllByRole('link', { name: /Available in TruePPM Enterprise/i });
    const captionBadge = allBadges.find((b) => !matrix.contains(b));
    expect(captionBadge).toBeDefined();
    expect(captionBadge).toHaveAttribute('href', 'https://trueppm.com/enterprise');
    expect(captionBadge).toHaveAttribute('target', '_blank');
  });

  it('suppresses the custom-roles upsell under the enterprise edition', () => {
    mockUseEdition.mockReturnValue({ edition: 'enterprise', isLoading: false });
    render(<WorkspaceRolesPage />);
    // The explanatory copy stays, but the EE badge (the upsell link) is gone.
    expect(screen.getByText(/Need custom roles/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Available in TruePPM Enterprise/i })).toBeNull();
  });
});
