import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectNotificationsPage, formatList } from './ProjectNotificationsPage';
import type {
  ProjectNotificationPreferences,
  ProjectNotificationPatch,
} from '@/hooks/useProjectNotificationPreferences';

const useProjectId = vi.fn();
const useProjectNotificationPreferences = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => useProjectId() as string | undefined,
}));

vi.mock('@/hooks/useProjectNotificationPreferences', async () => {
  const actual = await vi.importActual<
    typeof import('@/hooks/useProjectNotificationPreferences')
  >('@/hooks/useProjectNotificationPreferences');
  return {
    ...actual,
    useProjectNotificationPreferences: (id: string | undefined) =>
      useProjectNotificationPreferences(id) as unknown,
  };
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/p-1/settings/notifications']}>
        <Routes>
          <Route
            path="/projects/:projectId/settings/notifications"
            element={<ProjectNotificationsPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const SEED: ProjectNotificationPreferences = {
  // Mirrors the server's #2904 classification: only comment_mention is wired.
  eventDelivery: {
    task_assigned: false,
    task_overdue: false,
    comment_mention: true,
    status_change: false,
    budget_alert: false,
    risk_created: false,
    milestone_reached: false,
    sprint_start: false,
    sprint_end: false,
  },
  // Mirrors the server's #3378 classification: only in_app and email deliver.
  channelDelivery: { in_app: true, email: true, slack: false, mobile_push: false },
  matrix: {
    // A user's STORED preferences, not the defaults — rows written before a default
    // changed may legitimately still hold ON, which is why the markers are driven by
    // the two delivery maps and never inferred from the matrix.
    task_assigned: { in_app: true, email: true, slack: true, mobile_push: true },
    task_overdue: { in_app: true, email: true, slack: true, mobile_push: true },
    // The one dispatched row, seeded as #3378 now defaults it: the two undeliverable
    // columns are OFF even here, because the event being dispatched does not make a
    // channel that sends nothing deliver.
    comment_mention: { in_app: true, email: true, slack: false, mobile_push: false },
    status_change: { in_app: true, email: false, slack: false, mobile_push: false },
    budget_alert: { in_app: true, email: true, slack: true, mobile_push: true },
    risk_created: { in_app: true, email: true, slack: true, mobile_push: true },
    milestone_reached: { in_app: true, email: true, slack: true, mobile_push: false },
    sprint_start: { in_app: true, email: true, slack: true, mobile_push: false },
    sprint_end: { in_app: true, email: true, slack: true, mobile_push: false },
  },
  paused: false,
  quietHoursEnabled: true,
  quietHoursFrom: '20:00:00',
  quietHoursUntil: '07:00:00',
};

let mutate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useProjectId.mockReturnValue('p-1');
  mutate = vi.fn();
  useProjectNotificationPreferences.mockReturnValue({
    preferences: SEED,
    isLoading: false,
    error: null,
    update: { mutate },
  });
});

describe('ProjectNotificationsPage', () => {
  it('renders one row per event and one column per channel', () => {
    renderPage();
    expect(screen.getByText('Task assigned to me')).toBeInTheDocument();
    expect(screen.getByText('Sprint closed')).toBeInTheDocument();
    expect(screen.getAllByRole('switch').length).toBeGreaterThanOrEqual(9 * 4); // 36 toggles + quiet hours
  });

  it('renders contextual help for the routing matrix and quiet hours (#2266)', () => {
    renderPage();
    expect(
      screen.getByRole('button', { name: /About the Notification routing options/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /About the Quiet hours options/i }),
    ).toBeInTheDocument();
  });

  // #3378 — the routing help sat fifteen lines above markers saying the opposite.
  it('does not promise that toggling a cell delivers the event', () => {
    renderPage();
    fireEvent.click(
      screen.getByRole('button', { name: /About the Notification routing options/i }),
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).not.toHaveTextContent(/delivered through that channel/i);
    // It must still say what a toggle DOES do — de-promising is not the same as
    // saying nothing, or the control loses its explanation.
    expect(dialog).toHaveTextContent(/says you want that event on that channel/i);
    expect(dialog).toHaveTextContent(/not a promise that it reaches you/i);
    // Both axes, one sentence — the banner beside the grid used to name rows only.
    expect(dialog).toHaveTextContent(/rows and columns marked/i);
  });

  it('reflects seeded matrix values on each toggle', () => {
    renderPage();
    const overdueEmail = screen.getByRole('switch', { name: /task i own is overdue via email/i });
    expect(overdueEmail).toHaveAttribute('aria-checked', 'true');
    const statusEmail = screen.getByRole('switch', { name: /task moves to another column via email/i });
    expect(statusEmail).toHaveAttribute('aria-checked', 'false');
  });

  it('toggles a single matrix cell via partial PATCH', async () => {
    renderPage();
    const toggle = screen.getByRole('switch', { name: /task assigned to me via email/i });
    fireEvent.click(toggle);
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    const arg = mutate.mock.calls[0][0] as ProjectNotificationPatch;
    expect(arg.matrix).toEqual({ task_assigned: { email: false } });
  });

  it('toggles quiet hours via PATCH', async () => {
    renderPage();
    const quiet = screen.getByRole('switch', { name: /quiet hours/i });
    fireEvent.click(quiet);
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0][0]).toEqual({ quietHoursEnabled: false });
  });

  it('persists a new quiet hours start time as HH:MM:SS', async () => {
    renderPage();
    const from = screen.getByLabelText('From');
    fireEvent.change(from, { target: { value: '22:00' } });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0][0]).toEqual({ quietHoursFrom: '22:00:00' });
  });

  it('renders a loading state when the query has not resolved yet', () => {
    useProjectNotificationPreferences.mockReturnValue({
      preferences: undefined,
      isLoading: true,
      error: null,
      update: { mutate },
    });
    renderPage();
    // Rule 248: a skeleton ghost with a named status node, never bare text (#2431).
    expect(screen.getByRole('status', { name: /Loading notification rules/i })).toBeInTheDocument();
  });

  it('renders the pause-all kill-switch above the matrix (#589)', () => {
    renderPage();
    const pause = screen.getByRole('switch', { name: /pause all project notifications/i });
    expect(pause).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/one-click opt-out/i)).toBeInTheDocument();
  });

  it('PATCHes paused=true when the kill-switch is toggled on (#589)', async () => {
    renderPage();
    const pause = screen.getByRole('switch', { name: /pause all project notifications/i });
    fireEvent.click(pause);
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0][0]).toEqual({ paused: true });
  });

  it('shows the paused copy and dims the matrix when paused=true (#589)', () => {
    useProjectNotificationPreferences.mockReturnValue({
      preferences: { ...SEED, paused: true },
      isLoading: false,
      error: null,
      update: { mutate },
    });
    renderPage();
    expect(screen.getByText(/^Paused —/i)).toBeInTheDocument();
    const pause = screen.getByRole('switch', { name: /pause all project notifications/i });
    expect(pause).toHaveAttribute('aria-checked', 'true');
  });

  // #2904 — eight of the nine rows are dispatched by nothing. They render, and
  // toggling one has no effect in either direction. The page must say so rather
  // than presenting them identically to the one that works.
  it('labels the rows the server reports as not dispatched', () => {
    renderPage();

    // By title, not text: the explanatory banner repeats the badge wording, so a
    // text query would count 9 (8 badges + the banner's inline reference).
    expect(screen.getAllByTitle(/not dispatched yet/i)).toHaveLength(8);
    // The banner names both axes now (#3378), so it is matched on its own opening
    // rather than on the row-only wording it used to carry.
    expect(screen.getByText(/^Rows and columns marked/i)).toBeInTheDocument();
    expect(screen.getByText(/send nothing today/i)).toBeInTheDocument();
  });

  it('leaves an undispatched row fully interactive', () => {
    renderPage();

    // De-emphasis must never remove function: the preference is still saved, and
    // applies once the dispatcher lands. A disabled toggle would discard intent.
    const toggle = screen.getByRole('switch', { name: /Sprint started via email/i });
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('shows no labels or banner when every row is dispatched', () => {
    useProjectNotificationPreferences.mockReturnValue({
      preferences: {
        ...SEED,
        eventDelivery: Object.fromEntries(
          Object.keys(SEED.eventDelivery).map((event) => [event, true]),
        ),
      },
      isLoading: false,
      error: null,
      update: { mutate },
    });
    renderPage();

    expect(screen.queryByTitle(/not dispatched yet/i)).not.toBeInTheDocument();
    // The banner stays, because the COLUMN axis still has two dead members — it
    // explains both axes and fires on either (#3378). Before that it was gated on
    // the row axis alone, so exactly this state rendered two column markers whose
    // consequence was stated nowhere at rest.
    expect(screen.getByText(/^Rows and columns marked/i)).toBeInTheDocument();
  });

  it('drops the banner and the explainer card only when BOTH axes are clean', () => {
    useProjectNotificationPreferences.mockReturnValue({
      preferences: {
        ...SEED,
        eventDelivery: Object.fromEntries(
          Object.keys(SEED.eventDelivery).map((event) => [event, true]),
        ),
        channelDelivery: { in_app: true, email: true, slack: true, mobile_push: true },
      },
      isLoading: false,
      error: null,
      update: { mutate },
    });
    renderPage();

    expect(screen.queryByTitle(/not dispatched yet/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/does not deliver on this channel yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Rows and columns marked/i)).not.toBeInTheDocument();
    // The card is built from the dead set, so an empty set renders no card at all.
    // Hardcoded, it kept asserting "TruePPM does not deliver to Slack or mobile push"
    // under an <h2> while the markers above it had gone — and the loud half wins.
    expect(
      screen.queryByRole('heading', { name: /does not deliver on yet/i }),
    ).not.toBeInTheDocument();
  });

  it('names only the channels the server marks dead in the explainer card', () => {
    useProjectNotificationPreferences.mockReturnValue({
      preferences: {
        ...SEED,
        channelDelivery: { in_app: true, email: true, slack: true, mobile_push: false },
      },
      isLoading: false,
      error: null,
      update: { mutate },
    });
    renderPage();

    expect(
      screen.getByRole('heading', { name: /does not deliver on yet/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/does not deliver notifications to mobile push yet/i))
      .toBeInTheDocument();
    // The webhook pointer is about Slack specifically, so it goes when Slack works.
    expect(screen.queryByText(/project-wide feed/i)).not.toBeInTheDocument();
  });

  it('shows no labels when an older server sends no classification', () => {
    // Absence is "no claim made", never "nothing is delivered" — an older API
    // must not make the whole matrix look broken.
    useProjectNotificationPreferences.mockReturnValue({
      preferences: { ...SEED, eventDelivery: {} },
      isLoading: false,
      error: null,
      update: { mutate },
    });
    renderPage();

    expect(screen.queryByTitle(/not dispatched yet/i)).not.toBeInTheDocument();
    // The banner still renders: the column axis is unaffected by an absent row
    // classification, and it explains both.
    expect(screen.getByText(/^Rows and columns marked/i)).toBeInTheDocument();
  });

  // #3249 — nothing in apps/notifications delivers on Slack or mobile push, and
  // no setting anywhere turns them on. Unmarked, the columns read as working
  // controls. The row badges are per-event and cannot cover this: the channel is
  // dead for every row, including the one event that IS dispatched.
  // #3378 — the accessible name is the ONLY place either marker reaches the control:
  // aria-label overrides sibling content, the row badge is a sibling span, the column
  // marker is in an unrelated header row, and the CSS grid has no table semantics.
  it('names each switch by its channel label and states when the cell is dead', () => {
    renderPage();

    // Label, not the raw enum key — this announced "via mobile_push" before.
    expect(
      screen.getByRole('switch', {
        name: 'Mention (@) in a comment via Mobile push, not delivered yet',
      }),
    ).toBeInTheDocument();
    // Dead because of the ROW, on a channel that delivers.
    expect(
      screen.getByRole('switch', { name: 'Sprint started via Email, not delivered yet' }),
    ).toBeInTheDocument();
    // Live on both axes: no state suffix.
    expect(
      screen.getByRole('switch', { name: 'Mention (@) in a comment via Email' }),
    ).toBeInTheDocument();
  });

  it('marks the channels with no delivery path, and only those', () => {
    renderPage();

    const marked = screen.getAllByTitle(/does not deliver on this channel yet/i);
    expect(marked).toHaveLength(2);
    marked.forEach((el) => expect(el).toHaveTextContent(/not delivered yet/i));
  });

  it('marks the undeliverable columns even when every event is dispatched', () => {
    // The two markers are independent of the per-event classification — a server
    // that wires all nine dispatchers still cannot deliver to Slack or push.
    useProjectNotificationPreferences.mockReturnValue({
      preferences: {
        ...SEED,
        eventDelivery: Object.fromEntries(
          Object.keys(SEED.eventDelivery).map((event) => [event, true]),
        ),
      },
      isLoading: false,
      error: null,
      update: { mutate },
    });
    renderPage();

    expect(screen.getAllByTitle(/does not deliver on this channel yet/i)).toHaveLength(2);
  });

  // #3378 — the markers now come off the server's channel_delivery map. The
  // hardcoded list survives only for a server too old to send one.
  it('takes the column markers from the server, not from a hardcoded list', () => {
    // A server that has shipped Slack delivery: the column must un-mark itself
    // without a web release. Under the old constant this rendered a "not delivered
    // yet" label on a channel that now works.
    useProjectNotificationPreferences.mockReturnValue({
      preferences: {
        ...SEED,
        channelDelivery: { in_app: true, email: true, slack: true, mobile_push: false },
      },
      isLoading: false,
      error: null,
      update: { mutate },
    });
    renderPage();

    const marked = screen.getAllByTitle(/does not deliver on this channel yet/i);
    expect(marked).toHaveLength(1);
    // The surviving marker is mobile push — asserted through the column header it
    // sits in, because the label text is identical on both columns.
    expect(marked[0].parentElement).toHaveTextContent(/mobile push/i);
  });

  it('falls back to the hardcoded list when an older server sends no channel map', () => {
    // Absence here is NOT "no claim made" (the eventDelivery contract): the two
    // columns are still dead on that server, so dropping the markers would be the
    // #3249 defect returning against an older API.
    useProjectNotificationPreferences.mockReturnValue({
      preferences: { ...SEED, channelDelivery: {} },
      isLoading: false,
      error: null,
      update: { mutate },
    });
    renderPage();

    expect(screen.getAllByTitle(/does not deliver on this channel yet/i)).toHaveLength(2);
  });

  it('does not tell the user to configure Slack notification delivery in Integrations', () => {
    // The card used to read "Configure Slack channels for your workspace in
    // Project Settings → Integrations" and route three levels to "Configure in
    // Integrations". That page has no Slack configuration and none exists, so the
    // instruction sent people somewhere that could not help them.
    renderPage();

    expect(screen.queryByText(/Slack channel routing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Configure in Integrations/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/does not deliver notifications to slack and mobile push yet/i),
    ).toBeInTheDocument();
    // The webhook pointer is a real, different capability — it must stay marked
    // as project-wide so it is not read as a fix for the matrix above.
    expect(screen.getByText(/project-wide feed/i)).toBeInTheDocument();
  });

  // #3397 — the window is a bare wall-clock range, so the page has to say what
  // zone "20:00" is read in and which scope decided it.
  describe('resolved quiet-hours timezone', () => {
    function seedWithZone(
      zone: string | undefined,
      source: ProjectNotificationPreferences['quietHoursTimezoneSource'],
    ) {
      useProjectNotificationPreferences.mockReturnValue({
        preferences: { ...SEED, quietHoursTimezone: zone, quietHoursTimezoneSource: source },
        isLoading: false,
        error: null,
        update: { mutate },
      });
    }

    it('states the zone the window is read in', () => {
      seedWithZone('Asia/Tokyo', 'project');
      renderPage();
      expect(
        screen.getByText("Times are in Asia/Tokyo — this project's timezone."),
      ).toBeInTheDocument();
    });

    it('names the workspace as the owner when the project inherits', () => {
      seedWithZone('Europe/Berlin', 'workspace');
      renderPage();
      // The scope is what tells a member who to ask to change it.
      expect(screen.getByText(/the workspace default timezone/)).toBeInTheDocument();
      expect(screen.getByText(/Europe\/Berlin/)).toBeInTheDocument();
    });

    it.each(['server', 'fallback'] as const)(
      'still states the zone on the %s degradation tier, without warning chrome',
      (source) => {
        seedWithZone('UTC', source);
        renderPage();
        // Suppressing the line here would leave a member unable to tell that
        // 20:00 means 20:00 UTC — strictly worse than the pre-#3397 page.
        const note = screen.getByText(/Times are in UTC/);
        expect(note).toBeInTheDocument();
        // No alert/status role: a member cannot fix either condition, so an
        // alarm they cannot act on is noise (rule 274's spirit).
        expect(note).not.toHaveAttribute('role');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      },
    );

    it('describes both time selects with the zone, for the person picking the time', () => {
      seedWithZone('Asia/Tokyo', 'project');
      renderPage();
      const note = screen.getByText("Times are in Asia/Tokyo — this project's timezone.");
      for (const label of ['From', 'Until']) {
        const select = screen.getByLabelText(label);
        expect(select).toHaveAttribute('aria-describedby', note.id);
      }
      expect(note.id).toBeTruthy();
    });

    it('renders nothing at all when the response predates #3377', () => {
      // A cached document with no zone must not degrade to "(undefined)" or to
      // a silently-assumed UTC — it makes no claim, so the page makes none.
      seedWithZone(undefined, undefined);
      renderPage();
      expect(screen.queryByText(/Times are in/)).not.toBeInTheDocument();
      expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
      expect(screen.getByLabelText('From')).not.toHaveAttribute('aria-describedby');
    });

    it('keeps stating the zone while quiet hours are switched off', () => {
      // The selects stay rendered and editable when the toggle is off, so the
      // numbers still need their zone.
      useProjectNotificationPreferences.mockReturnValue({
        preferences: {
          ...SEED,
          quietHoursEnabled: false,
          quietHoursTimezone: 'Asia/Tokyo',
          quietHoursTimezoneSource: 'project',
        },
        isLoading: false,
        error: null,
        update: { mutate },
      });
      renderPage();
      expect(screen.getByText(/Times are in Asia\/Tokyo/)).toBeInTheDocument();
    });
  });

  it('renders an error state on API failure', () => {
    useProjectNotificationPreferences.mockReturnValue({
      preferences: undefined,
      isLoading: false,
      error: new Error('boom'),
      update: { mutate },
    });
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(/failed to load preferences/i);
  });
});

describe('formatList', () => {
  // The empty and three-or-more branches cannot be reached through the page — the
  // card is gated on a non-empty set, and only two of four columns are dead — so
  // this is the only place they are exercised at all.
  it.each<[string[], string]>([
    [[], ''],
    [['Slack'], 'Slack'],
    [['Slack', 'mobile push'], 'Slack and mobile push'],
    [['Slack', 'mobile push', 'SMS'], 'Slack, mobile push, and SMS'],
  ])('renders %j as %j', (items, expected) => {
    expect(formatList(items)).toBe(expected);
  });
});
