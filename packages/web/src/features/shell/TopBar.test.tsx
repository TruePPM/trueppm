import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { useThemeStore } from '@/stores/themeStore';
import { useShellStore } from '@/stores/shellStore';
import { TopBar } from './TopBar';

// Route + data hooks are driven by mutable fixtures so each test can pick a context.
let projectId: string | undefined = 'test-project-id';
let programId: string | undefined;
let projectData: unknown = {
  id: 'test-project-id',
  name: 'Launch Site',
  methodology: 'HYBRID',
  program_detail: { id: 'prog-1', name: 'Apollo' },
};
let programData: unknown = { id: 'prog-1', name: 'Apollo', color: '#3E8C6D', code: 'APL' };
let presenceUsers: { user_id: string; display_name: string }[] = [];
let currentUser: { id: string } | null = null;

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => projectId }));
vi.mock('@/hooks/useProgramId', () => ({ useProgramId: () => programId }));
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: projectData, isLoading: false, error: null }),
}));
vi.mock('@/hooks/useProgram', () => ({ useProgram: () => ({ data: programData }) }));
vi.mock('@/hooks/useProjectPresence', () => ({
  useProjectPresence: (id: string | undefined) => (id ? presenceUsers : []),
}));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: currentUser, isLoading: false }),
}));
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: 200, isLoading: false }),
}));
vi.mock('@/hooks/useNotifications', () => ({
  useUnreadNotificationCount: () => ({ count: 0, isLoading: false }),
}));
// The health cluster + create menu own their own data hooks and are covered by their
// own specs; stub them so the structural TopBar tests don't fire their XHRs.
// Capture the `onTaskNavigate` callback TopBar hands the cluster so a spec can
// exercise `handleTaskNavigate` (the "what's on fire → take me there" route, #2032)
// without rendering the real cluster's data hooks.
let capturedTaskNavigate: ((id: string) => void) | undefined;
// Segment count is mutable so the #2533 overflow specs can grow the cluster from
// three segments to seven without reaching into `healthClusterModel` (which #2531
// owns) — the bar's contract is that segment count is the cluster's business.
let healthSegmentCount = 3;
vi.mock('./HealthCluster', () => ({
  HealthCluster: (props: { onTaskNavigate: (id: string) => void }) => {
    capturedTaskNavigate = props.onTaskNavigate;
    return (
      <div data-testid="health-cluster">
        {Array.from({ length: healthSegmentCount }, (_, i) => (
          <span key={i} data-testid="health-segment">
            segment {i}
          </span>
        ))}
      </div>
    );
  },
}));
vi.mock('./CreateMenu', () => ({ CreateMenu: () => null }));
// The running-timer chip owns its own /me/timer/ query (covered by its own spec);
// stub it so the structural TopBar tests don't fire that XHR (#1415).
vi.mock('@/features/timer/TimerChip', () => ({ TimerChip: () => null }));
vi.mock('@/features/programs/ProgramIdentitySquare', () => ({
  ProgramIdentitySquare: () => <span data-testid="identity-square" aria-hidden="true" />,
}));
// The location switcher owns its own route/data hooks and is covered by its own
// specs; stub it so the structural TopBar tests assert the bar's composition, not
// the switcher's internals (#1643).
vi.mock('./LocationSwitcher', () => ({
  LocationSwitcher: () => <nav data-testid="location-switcher" aria-label="Location" />,
}));

// Stub useNavigate to avoid react-router navigation side-effects in JSDOM tests.
const mockNavigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

beforeEach(() => {
  projectId = 'test-project-id';
  programId = undefined;
  projectData = {
    id: 'test-project-id',
    name: 'Launch Site',
    methodology: 'HYBRID',
    program_detail: { id: 'prog-1', name: 'Apollo' },
  };
  programData = { id: 'prog-1', name: 'Apollo', color: '#3E8C6D', code: 'APL' };
  presenceUsers = [];
  currentUser = null;
  healthSegmentCount = 3;
  useThemeStore.setState({ theme: 'auto' });
  useShellStore.setState({ sidebarCollapsed: false, sidebarUserControlled: false });
});

describe('TopBar (unified shell bar, ADR-0134)', () => {
  it('renders the logo (mobile brand)', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByLabelText('TruePPM')).toBeInTheDocument();
  });

  it('renders the location switcher (replaces the breadcrumb + in-chrome ProjectSwitcher)', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByTestId('location-switcher')).toBeInTheDocument();
  });

  it('no longer carries the view-tab strip in the bar — the rail owns view switching (#1642/#1643)', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    // The bar's only nav is the location switcher; the old grouped view-tab nav and
    // its Schedule/Board/Grid links are gone (they live in the left rail now).
    expect(screen.queryByRole('navigation', { name: /^view$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Schedule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Board' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /plan views/i })).not.toBeInTheDocument();
  });

  it('no longer carries the ProgramTabs strip, even in a program context (#1920)', () => {
    // Program view switching moved to the rail's "This program" tier; the bar must
    // render no "Program" nav even when a program is active.
    programId = 'prog-1';
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.queryByRole('navigation', { name: /^program$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Backlog/i })).not.toBeInTheDocument();
  });

  it('renders the health cluster and no longer carries the relocated affordances (#1680)', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByTestId('health-cluster')).toBeInTheDocument();
    // Customize-views (→ rail) and the current-sprint jump (→ health popover) left
    // the bar's right cluster in #1680. The methodology tag also left for the rail
    // subtitle, but only while the rail is expanded — this test's default
    // `sidebarCollapsed: false` state is exactly that, so the bar's restored
    // `MethodologyIndicator` (#1907) correctly renders nothing here too; see the
    // dedicated `MethodologyIndicator` describe block below for the collapsed case.
    expect(screen.queryByRole('button', { name: 'Customize views' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /current sprint/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/workspace/i)).not.toBeInTheDocument();
  });

  describe('MethodologyIndicator wiring (issue #1907)', () => {
    it('shows the always-visible methodology badge while the rail is collapsed', () => {
      useShellStore.setState({ sidebarCollapsed: true, sidebarUserControlled: false });
      renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
      expect(screen.getByRole('img', { name: 'Hybrid workspace' })).toHaveTextContent('HY');
    });

    it('hides the bar badge once the rail is expanded, so the rail subtitle is the sole signal', () => {
      useShellStore.setState({ sidebarCollapsed: false, sidebarUserControlled: false });
      renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
      expect(screen.queryByRole('img', { name: /workspace$/i })).not.toBeInTheDocument();
    });
  });

  it('renders hamburger + account menu', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: /open sidebar/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /account/i }).length).toBeGreaterThan(0);
  });

  it('calls onHamburgerClick when the hamburger is clicked', async () => {
    const user = userEvent.setup();
    const onHamburgerClick = vi.fn();
    renderWithRouter(<TopBar onHamburgerClick={onHamburgerClick} />);
    await user.click(screen.getByRole('button', { name: /open sidebar/i }));
    expect(onHamburgerClick).toHaveBeenCalledOnce();
  });

  // --- presence (absorbed from the old ContextBar, ADR-0127/0134) ---

  it('shows presence avatars on a project route, excluding self', () => {
    currentUser = { id: 'me' };
    presenceUsers = [
      { user_id: 'me', display_name: 'Me Myself' },
      { user_id: 'u-alice', display_name: 'Alice Smith' },
    ];
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    // Disambiguate from the SyncStatusBadge's own aria-live status region (#374)
    // by the presence accessible name.
    const presence = screen.getByRole('status', { name: /viewing|Alice Smith/ });
    expect(presence).toHaveAccessibleName(/Alice Smith/);
    expect(presence).not.toHaveAccessibleName(/Me Myself/);
  });

  // --- rail re-open toggle (absorbed from the old ContextBar, ADR-0127) ---

  it('toggles the rail and reflects state via aria-expanded', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'Hide navigation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(useShellStore.getState().sidebarCollapsed).toBe(true);
    expect(screen.getByRole('button', { name: 'Show navigation' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  // --- health drill-down routing (#2032) ---

  it('routes a health-cluster task pick to that project\'s Schedule, not the landing page', () => {
    mockNavigate.mockClear();
    projectId = 'proj-42';
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    // Simulate the popover handing back a picked task.
    capturedTaskNavigate?.('t-9');
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-42/schedule');
    // The old stale single-project path must be gone.
    expect(mockNavigate).not.toHaveBeenCalledWith('/');
  });

  it('does not navigate on a health task pick when off-project (no projectId)', () => {
    mockNavigate.mockClear();
    projectId = undefined;
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    capturedTaskNavigate?.('t-9');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  // --- "me" identity divider (#1736, design §02) ---

  it('fences the "me" identity chip off from the presence/sync/bell utility cluster with a decorative divider', () => {
    const { container } = renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    const divider = container.querySelector('span[aria-hidden="true"].bg-chrome-border\\/40');
    expect(divider).toBeInTheDocument();
    // Decorative only — never announced to assistive tech.
    expect(divider).toHaveAttribute('aria-hidden', 'true');

    // Positioned between the notification bell and the account (UserMenu)
    // button — the divider's entire job is to sit at that seam, not merely
    // exist somewhere in the bar. DOM order (not just presence) is the point:
    // walk the whole bar in document order and assert the divider lands
    // strictly between the two.
    const bell = screen.getByRole('button', { name: /notifications/i });
    const account = screen.getAllByRole('button', { name: /account/i })[0];
    const ordered = Array.from(container.querySelectorAll<HTMLElement>('button, span[aria-hidden="true"]'));
    const bellIndex = ordered.indexOf(bell);
    const dividerIndex = ordered.indexOf(divider as HTMLElement);
    const accountIndex = ordered.indexOf(account);
    expect(bellIndex).toBeGreaterThanOrEqual(0);
    expect(dividerIndex).toBeGreaterThan(bellIndex);
    expect(accountIndex).toBeGreaterThan(dividerIndex);
  });

  // --- context-bar overflow contract (#2533) ---
  //
  // JSDOM has no layout engine, so a literal `offsetWidth` comparison here would
  // assert 0 === 0 and pass no matter what the bar does. These specs therefore
  // pin the *structural* invariants that make the breadcrumb's width stable —
  // it is outside the scrolling region, and nothing about its box changes as the
  // cluster grows — and leave the measured, pixel-level assertion to the
  // Playwright spec (`unified-shell-bar.spec.ts`), which has a real engine.
  describe('overflow contract (#2533)', () => {
    /** Every direct child of the bar, as `tag.className` — the bar's own layout. */
    function barLayout(container: HTMLElement): string[] {
      const header = container.querySelector('header');
      expect(header).not.toBeNull();
      return Array.from(header!.children).map((c) => `${c.tagName}.${c.className}`);
    }

    it('leaves the breadcrumb\'s layout untouched as the cluster grows from 3 to 7 segments', () => {
      healthSegmentCount = 3;
      const three = renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
      // Guard against a vacuous pass: the cluster really did grow.
      expect(three.getAllByTestId('health-segment')).toHaveLength(3);
      const layoutAtThree = barLayout(three.container);
      three.unmount();

      healthSegmentCount = 7;
      const seven = renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
      expect(seven.getAllByTestId('health-segment')).toHaveLength(7);

      // The bar's own children — including the breadcrumb — are byte-identical:
      // four extra segments changed nothing outside the scrolling cluster.
      expect(barLayout(seven.container)).toEqual(layoutAtThree);
    });

    it('keeps the breadcrumb out of the scrolling region entirely', () => {
      healthSegmentCount = 7;
      const { container, getByTestId } = renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
      const scroller = getByTestId('shell-status-cluster');
      const breadcrumb = getByTestId('location-switcher');

      // A scrolling ancestor is the mechanism by which the breadcrumb would be
      // displaced; it must be a direct child of the bar instead.
      expect(scroller.contains(breadcrumb)).toBe(false);
      expect(breadcrumb.parentElement).toBe(container.querySelector('header'));
    });

    it('gives the status cluster the overflow rule, with no reserved scrollbar gutter', () => {
      const { getByTestId } = renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
      const cls = getByTestId('shell-status-cluster').className;

      // The fix itself: the cluster scrolls instead of pushing.
      expect(cls).toContain('min-w-0');
      expect(cls).toContain('overflow-x-auto');
      // Each segment keeps its natural width inside the viewport — without this
      // the flex items compress and the overflow never happens (#2208).
      expect(cls).toContain('[&>*]:shrink-0');
      // Same scrollbar treatment as the shell's other horizontal scroller
      // (`ShellNavScroller`, rule 174): no gutter is reserved, so overflow
      // appearing shifts nothing.
      expect(cls).toContain('[scrollbar-width:none]');
      expect(cls).toContain('[&::-webkit-scrollbar]:hidden');
      // The one animated affordance is gated (rule 70 — motion only, never
      // function: reduced motion still scrolls, just without the easing).
      expect(cls).toContain('scroll-smooth');
      expect(cls).toContain('motion-reduce:scroll-auto');
    });

    it('makes the right region absorb the bar\'s shrink so the breadcrumb keeps its width', () => {
      const { getByTestId } = renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
      const region = getByTestId('shell-status-cluster').closest('header > div');
      expect(region).not.toBeNull();
      expect(region!.className).toContain('md:shrink-[9999]');
      // …but the region must KEEP its automatic minimum size. `min-w-0` here
      // would let the 9999 shrink weight drive the whole region to zero, and the
      // `shrink-0` pinned chrome inside it would spill off the right edge of the
      // bar — the account chip leaving the viewport is the exact defect the split
      // exists to prevent. The floor belongs on the region; the two inner groups
      // carry `min-w-0` themselves.
      expect(region!.className).not.toContain('min-w-0');
    });

    it('keeps the pinned chrome outside the scroll viewport — the account chip can never scroll out of reach', () => {
      healthSegmentCount = 7;
      const { getByTestId, getAllByRole } = renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
      const scroller = getByTestId('shell-status-cluster');
      const account = getAllByRole('button', { name: /account/i })[0];
      const bell = screen.getByRole('button', { name: /notifications/i });
      expect(scroller.contains(account)).toBe(false);
      expect(scroller.contains(bell)).toBe(false);
    });

    it('never makes the scroll viewport a focus dead-end — no inert/negative tabindex on the region', () => {
      const { getByTestId } = renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
      const scroller = getByTestId('shell-status-cluster');
      // A scrolled-out segment stays reachable because it is still a normal
      // focusable control in document order; the container must not remove it
      // from the tab sequence or hide it from assistive tech.
      expect(scroller).not.toHaveAttribute('tabindex');
      expect(scroller).not.toHaveAttribute('inert');
      expect(scroller).not.toHaveAttribute('aria-hidden');
    });
  });
});
