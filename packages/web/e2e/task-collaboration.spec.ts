import { test, expect, type Page, type Route } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

/**
 * E2E coverage for the task collaboration cluster (#310 attachments + #311
 * comments / mentions / notifications, ADR-0075).
 *
 * Surfaces verified end-to-end:
 *   - Task drawer Attachments section: file upload, external-link pin,
 *     download-via-signed-URL, http(s) scheme validation
 *   - Task drawer Comments section: @-mention autocomplete (groups +
 *     individuals + Admin-gated @all), Cmd+Enter submit, ack + react do not
 *     trigger notifications
 *   - TopBar notification bell + slide-out panel: badge count, list, click
 *     navigates + auto-marks read, empty state
 *   - /me/settings/notifications preference matrix: desktop table layout,
 *     mobile stacked card layout, debounced auto-save toast
 *
 * All API calls are intercepted with Playwright route mocking. The
 * `mention_individual` toggle test exercises the desktop table at the
 * default viewport, then resizes to 375px to verify the mobile layout.
 *
 * Assumptions made (verify before relying on them):
 *   - The drawer is opened by clicking the task name in the schedule grid
 *     (matches the existing task-drawer-redesign.spec.ts pattern).
 *   - The hidden file input is `<input type="file" className="sr-only">`
 *     inside AttachmentSection; we scope it to the Attachments region so
 *     any drawer-internal pickers don't collide.
 *   - The bell-count assertion only covers what the server returns
 *     directly: `useUnreadNotificationCount` polls every 30 s and is NOT
 *     invalidated by comment-create on the same page, so we don't try to
 *     observe a bell update after posting a comment in the same test.
 *     Panel-side count behaviour (open → list → click → auto-mark-read →
 *     count decrements) is asserted in its own dedicated block.
 *   - NotificationRow.handleNavigate navigates to
 *     `/projects/{project}/schedule?task={task_id}` — the schedule view does
 *     not currently consume the `?task=` query param (no useSearchParams
 *     hook), so we only assert the URL change, not that the drawer
 *     re-opens for the linked task.
 */

const PROJECT_ID = 'e2e-collab-00000000-0000-0000-0000-000000000311';
const TASK_ID = 't-collab-1';
const COMMENT_ID = 'c-existing-1';
const ATTACHMENT_ID = 'att-existing-1';
const SIGNED_URL = 'https://blob.example.com/signed/abc?sig=xyz';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: 'Collab Test Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  estimation_mode: 'open',
  // Resolved attachment policy (ADR-0153, #976) — the drawer gates the add-control
  // and mirrors the allow-list from these. Uploads enabled with the system seed set.
  effective_attachments_enabled: true,
  effective_allowed_attachment_types: [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
};

const FIXTURE_USER = {
  id: 'user-priya',
  username: 'priya',
  display_name: 'Priya Patel',
  initials: 'PP',
  email: 'priya@example.com',
};

const FIXTURE_TASK = {
  id: TASK_ID,
  wbs_path: '1',
  name: 'Wire HVAC controls',
  early_start: '2026-10-05',
  early_finish: '2026-10-16',
  duration: 10,
  percent_complete: 25,
  is_critical: false,
  is_milestone: false,
  is_summary: false,
  parent_id: null,
  actual_start: null,
  actual_finish: null,
  schedule_variance_days: null,
  baseline_start: null,
  baseline_finish: null,
  optimistic_duration: null,
  most_likely_duration: null,
  pessimistic_duration: null,
  estimate_status: null,
  status: 'IN_PROGRESS',
  planned_start: null,
  assignments: [],
};

// Project member fixture used by /members/ AND /members/?self=true. The
// composer's @-autocomplete pulls usernames from /members/; the @-all gate
// reads the caller's role from /members/?self=true. We mark Priya as a
// MEMBER (role=100) so the @all row renders disabled (Admin+ only).
const FIXTURE_MEMBERS = [
  { id: 'mem-priya', role: 100, user_detail: { id: 'user-priya', username: 'priya' } },
  { id: 'mem-sarah', role: 300, user_detail: { id: 'user-sarah', username: 'sarah' } },
  { id: 'mem-morgan', role: 200, user_detail: { id: 'user-morgan', username: 'morgan' } },
];

interface BootOpts {
  /** Existing attachments returned by the first list GET. */
  attachments?: unknown[];
  /** Existing comments returned by the first list GET. */
  comments?: unknown[];
  /** Mock unread-count value returned by /me/notifications/?unread_only&limit=0. */
  unreadCount?: number;
  /** Mock notification rows returned by /me/notifications/?... (without unread_only). */
  notifications?: unknown[];
  /** Mock notification preference rows returned by /me/notification-preferences/. */
  preferences?: unknown[];
}

/**
 * Register the common project/task/auth shell and the four task-collaboration
 * endpoint families. Tests can pass `opts` to override the list payloads;
 * stateful POST handlers (file upload, link pin, comment create, preference
 * patch) are registered here too so the lists stay consistent across the
 * subsequent GETs in the same test.
 */
async function bootProjectPage(page: Page, opts: BootOpts = {}): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [FIXTURE_PROJECT],
    projectId: PROJECT_ID,
    tasks: [FIXTURE_TASK],
    user: FIXTURE_USER,
    members: FIXTURE_MEMBERS,
    overview: { schedule_health: 'on_track', total_tasks: 1 },
  });

  // setupApiMocks's `?self=true` branch returns a single object with
  // role=300 (Admin). For these tests Priya must be a MEMBER (role 100) so
  // the @all autocomplete row renders disabled. Re-register the members
  // route (last-registered wins) to return an array shape both branches
  // can rely on — useCurrentUserRole expects `MembershipRow[]`.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('self') === 'true') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'mem-priya', role: 100, user_id: FIXTURE_USER.id }]),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE_MEMBERS),
    });
  });

  // Mutable stores so a POST in the same test sees the new row on the next GET.
  const attachments: unknown[] = [...(opts.attachments ?? [])];
  const comments: unknown[] = [...(opts.comments ?? [])];
  let unreadCount = opts.unreadCount ?? 0;
  const notifications: unknown[] = [...(opts.notifications ?? [])];
  const preferences: unknown[] = [...(opts.preferences ?? [])];

  // ----- Attachments -----
  const attachmentsPath = `**/api/v1/projects/${PROJECT_ID}/tasks/${TASK_ID}/attachments/`;
  await page.route(attachmentsPath, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      // Try JSON first (link pin); fall back to multipart parsing.
      let createdRow: Record<string, unknown> | null = null;
      const ct = req.headers()['content-type'] ?? '';
      if (ct.includes('application/json')) {
        const body = req.postDataJSON() as { external_url: string; external_title: string };
        createdRow = {
          id: `att-link-${attachments.length + 1}`,
          file: '',
          file_name: '',
          file_size: null,
          file_mime: 'text/uri-list',
          external_url: body.external_url,
          external_title: body.external_title,
          is_pinned: true,
          uploaded_by: { id: FIXTURE_USER.id, username: FIXTURE_USER.username, display_name: FIXTURE_USER.display_name },
          deleted_by: null,
          created_at: new Date().toISOString(),
          is_deleted: false,
          deleted_at: null,
        };
      } else {
        // Multipart file upload — extract filename from the raw body. We
        // don't need byte-perfect parsing; just enough to populate the row.
        const raw = req.postData() ?? '';
        const nameMatch = raw.match(/filename="([^"]+)"/);
        const filename = nameMatch ? nameMatch[1] : 'upload.bin';
        createdRow = {
          id: `att-file-${attachments.length + 1}`,
          file: `/media/attachments/${filename}`,
          file_name: filename,
          file_size: 1024,
          file_mime: filename.endsWith('.png') ? 'image/png' : 'application/pdf',
          external_url: '',
          external_title: '',
          is_pinned: false,
          uploaded_by: { id: FIXTURE_USER.id, username: FIXTURE_USER.username, display_name: FIXTURE_USER.display_name },
          deleted_by: null,
          created_at: new Date().toISOString(),
          is_deleted: false,
          deleted_at: null,
        };
      }
      attachments.push(createdRow);
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(createdRow),
      });
    }
    // GET list
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: attachments.length,
        next: null,
        previous: null,
        results: attachments,
      }),
    });
  });

  await page.route(
    `**/api/v1/projects/${PROJECT_ID}/tasks/${TASK_ID}/attachments/*/signed-url/`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          url: SIGNED_URL,
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        }),
      }),
  );

  // ----- Comments -----
  const commentsPath = `**/api/v1/projects/${PROJECT_ID}/tasks/${TASK_ID}/comments/`;
  await page.route(commentsPath, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as { body: string; parent: string | null };
      const newRow = {
        id: `c-new-${comments.length + 1}`,
        task: TASK_ID,
        parent: body.parent,
        author: {
          id: FIXTURE_USER.id,
          username: FIXTURE_USER.username,
          display_name: FIXTURE_USER.display_name,
        },
        body: body.body,
        edited_at: null,
        created_at: new Date().toISOString(),
        is_deleted: false,
        deleted_at: null,
        deleted_by: null,
        acknowledged_count: 0,
        reaction_count: 0,
        has_my_acknowledgement: false,
      };
      comments.push(newRow);
      // A successful comment with a mention bumps the (test) unread count
      // so the bell badge test can observe a delta.
      unreadCount += 1;
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(newRow),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: comments.length,
        next: null,
        previous: null,
        results: comments,
      }),
    });
  });

  // Ack toggle — POST adds, DELETE removes. Always 200; refetch returns the
  // updated comments list with `has_my_acknowledgement` flipped.
  await page.route(
    `**/api/v1/projects/${PROJECT_ID}/tasks/${TASK_ID}/comments/*/acknowledge/`,
    (route) => {
      const c = comments.find(
        (entry) => (entry as { id: string }).id === COMMENT_ID,
      ) as
        | (Record<string, unknown> & {
            has_my_acknowledgement: boolean;
            acknowledged_count: number;
          })
        | undefined;
      if (route.request().method() === 'POST') {
        if (c) {
          c.has_my_acknowledgement = true;
          c.acknowledged_count = (c.acknowledged_count ?? 0) + 1;
        }
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'ack-1',
            user: { id: FIXTURE_USER.id, username: FIXTURE_USER.username, display_name: FIXTURE_USER.display_name },
            created_at: new Date().toISOString(),
          }),
        });
      }
      // DELETE
      if (c) {
        c.has_my_acknowledgement = false;
        c.acknowledged_count = Math.max(0, (c.acknowledged_count ?? 0) - 1);
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deleted: 1 }),
      });
    },
  );

  await page.route(
    `**/api/v1/projects/${PROJECT_ID}/tasks/${TASK_ID}/comments/*/reactions/`,
    (route) => {
      const c = comments.find(
        (entry) => (entry as { id: string }).id === COMMENT_ID,
      ) as (Record<string, unknown> & { reaction_count: number }) | undefined;
      if (route.request().method() === 'POST') {
        if (c) c.reaction_count = (c.reaction_count ?? 0) + 1;
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'rxn-1',
            user: { id: FIXTURE_USER.id, username: FIXTURE_USER.username, display_name: FIXTURE_USER.display_name },
            emoji: '👍',
            created_at: new Date().toISOString(),
          }),
        });
      }
      return route.fulfill({ status: 204, contentType: 'application/json', body: '' });
    },
  );

  // ----- Notifications -----
  await page.route('**/api/v1/me/notifications/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'GET') {
      if (url.searchParams.get('limit') === '0') {
        // Unread-count poll.
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ count: unreadCount, next: null, previous: null, results: [] }),
        });
      }
      // Filtered list. Mirrors the server (ADR-0216): snoozed rows are hidden
      // from every view except ?snoozed=true; category is orthogonal.
      const now = Date.now();
      const isSnoozed = (n: unknown) => {
        const until = (n as { snoozed_until: string | null }).snoozed_until;
        return until != null && new Date(until).getTime() > now;
      };
      let results: unknown[];
      if (url.searchParams.get('snoozed') === 'true') {
        results = notifications.filter(isSnoozed);
      } else {
        results = notifications.filter((n) => !isSnoozed(n));
        if (url.searchParams.get('archived') === 'true') {
          results = results.filter((n) => (n as { is_archived: boolean }).is_archived);
        } else if (url.searchParams.get('unread_only') === 'true') {
          results = results.filter((n) => !(n as { is_read: boolean }).is_read);
        } else {
          results = results.filter((n) => !(n as { is_archived: boolean }).is_archived);
        }
      }
      const category = url.searchParams.get('category');
      if (category) {
        results = results.filter((n) => (n as { category: string }).category === category);
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: results.length,
          next: null,
          previous: null,
          results,
        }),
      });
    }
    if (req.method() === 'PATCH') {
      const id = url.pathname.split('/').filter(Boolean).pop();
      const patch = req.postDataJSON() as { is_read?: boolean; is_archived?: boolean };
      const row = notifications.find(
        (n) => (n as { id: string }).id === id,
      ) as Record<string, unknown> | undefined;
      if (row) {
        if (typeof patch.is_read === 'boolean') {
          // Only count flips that toggle to read; flipping back to unread
          // re-increments. This mirrors server semantics closely enough for
          // a UI test.
          if (patch.is_read && !row.is_read) unreadCount = Math.max(0, unreadCount - 1);
          if (!patch.is_read && row.is_read) unreadCount += 1;
          row.is_read = patch.is_read;
          row.read_at = patch.is_read ? new Date().toISOString() : null;
        }
        if (typeof patch.is_archived === 'boolean') {
          row.is_archived = patch.is_archived;
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(row),
        });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    if (req.method() === 'POST' && url.pathname.endsWith('/snooze/')) {
      // /me/notifications/{id}/snooze/ — set (or clear) snoozed_until.
      const segments = url.pathname.split('/').filter(Boolean);
      const id = segments[segments.length - 2]; // .../{id}/snooze/
      const body = req.postDataJSON() as { preset?: string; until?: string | null };
      const row = notifications.find((n) => (n as { id: string }).id === id) as
        | Record<string, unknown>
        | undefined;
      if (!row) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      let until: string | null;
      if (body.preset) {
        const hours = body.preset === '3h' ? 3 : body.preset === 'tomorrow' ? 20 : 1;
        until = new Date(Date.now() + hours * 3_600_000).toISOString();
      } else {
        until = body.until ?? null;
      }
      // A snoozed, still-unread row leaves the unread badge (server excludes it).
      if (until && !row.is_read) unreadCount = Math.max(0, unreadCount - 1);
      if (!until && !row.is_read) unreadCount += 1;
      row.snoozed_until = until;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(row),
      });
    }
    if (req.method() === 'POST' && url.pathname.endsWith('/mark-all-read/')) {
      let updated = 0;
      for (const n of notifications) {
        const row = n as { is_read: boolean; read_at: string | null };
        if (!row.is_read) {
          row.is_read = true;
          row.read_at = new Date().toISOString();
          updated += 1;
        }
      }
      unreadCount = 0;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ updated }),
      });
    }
    return route.fallback();
  });

  // ----- Notification preferences -----
  await page.route('**/api/v1/me/notification-preferences/**', async (route: Route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      // DRF paginates every list endpoint — return the {count,...,results}
      // envelope the real API sends, not a bare array (#792).
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: preferences.length,
          next: null,
          previous: null,
          results: preferences,
        }),
      });
    }
    if (req.method() === 'PATCH') {
      const id = Number(new URL(req.url()).pathname.split('/').filter(Boolean).pop());
      const patch = req.postDataJSON() as { enabled: boolean };
      const row = preferences.find(
        (p) => (p as { id: number }).id === id,
      ) as Record<string, unknown> | undefined;
      if (row) {
        row.enabled = patch.enabled;
        row.updated_at = new Date().toISOString();
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(row),
        });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    return route.fallback();
  });
}

async function openDrawer(page: Page): Promise<ReturnType<Page['locator']>> {
  await page.goto(`/projects/${PROJECT_ID}/schedule`);
  const grid = page.getByRole('grid', { name: 'Task list' });
  await expect(grid).toBeVisible({ timeout: 10_000 });
  await grid.getByText(FIXTURE_TASK.name, { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: new RegExp(FIXTURE_TASK.name) }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  return drawer;
}

// The redesigned drawer (#962) groups registry sections into four tabs; a
// section's header only mounts once its owning tab is active, so openSection
// must switch tabs first. Kept in sync with sections/index.ts tab assignments.
const SECTION_TAB: Record<string, string> = {
  Attachments: 'Files',
  'External links': 'Files',
  Notes: 'Activity',
  Comments: 'Activity',
  Activity: 'Activity',
};

/** Switch to the tab that owns `name`, then expand its (possibly collapsed) section. */
async function openSection(drawer: ReturnType<Page['locator']>, name: string): Promise<void> {
  const tabLabel = SECTION_TAB[name];
  if (tabLabel) {
    await drawer.getByRole('tab', { name: new RegExp(`^${tabLabel}`) }).click();
  }
  const header = drawer.getByRole('button', { name });
  await expect(header).toBeVisible();
  const expanded = await header.getAttribute('aria-expanded');
  if (expanded !== 'true') await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
}

// =============================================================================
// 1. Attachment upload golden path
// =============================================================================

test.describe('Task collaboration — attachments (#310)', () => {
  test('uploads a PNG via the hidden file input and renders the new row', async ({ page }) => {
    await bootProjectPage(page);
    const drawer = await openDrawer(page);
    await openSection(drawer, 'Attachments');

    // The hidden <input type="file" className="sr-only"> lives inside the
    // Attachments region. Use the region scope so the locator is precise.
    const attachmentsRegion = drawer.getByRole('region', { name: /Attachments/ });
    const fileInput = attachmentsRegion.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'site-photo.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG magic
    });

    // The new row renders with filename + uploader + relative timestamp.
    const newRow = drawer.getByRole('listitem', { name: 'Attachment: site-photo.png' });
    await expect(newRow).toBeVisible({ timeout: 5_000 });
    await expect(newRow).toContainText(FIXTURE_USER.display_name);
  });

  test('clicking download requests a signed URL', async ({ page }) => {
    const existingAttachment = {
      id: ATTACHMENT_ID,
      file: '/media/attachments/spec.pdf',
      file_name: 'spec.pdf',
      file_size: 4096,
      file_mime: 'application/pdf',
      external_url: '',
      external_title: '',
      is_pinned: false,
      uploaded_by: {
        id: FIXTURE_USER.id,
        username: FIXTURE_USER.username,
        display_name: FIXTURE_USER.display_name,
      },
      deleted_by: null,
      created_at: '2026-05-19T12:00:00Z',
      is_deleted: false,
      deleted_at: null,
    };
    await bootProjectPage(page, { attachments: [existingAttachment] });

    const drawer = await openDrawer(page);
    await openSection(drawer, 'Attachments');

    // Capture the signed-URL request before clicking; matches by path so we
    // don't race the mutation handler.
    const signedUrlRequest = page.waitForRequest((req) =>
      req.url().includes(`/attachments/${ATTACHMENT_ID}/signed-url/`),
    );
    await drawer.getByRole('button', { name: 'Download spec.pdf' }).click();
    const req = await signedUrlRequest;
    expect(req.method()).toBe('GET');
  });

  test('pinning an external link renders the row with the URL host', async ({ page }) => {
    await bootProjectPage(page);
    const drawer = await openDrawer(page);
    await openSection(drawer, 'Attachments');

    // The trigger label is "+ Pin link" (with the + glyph); the modal's
    // submit button is "Pin link" alone. Match exactly to avoid the
    // strict-mode collision after the modal opens.
    await drawer.getByRole('button', { name: '+ Pin link' }).click();
    const modal = page.getByRole('dialog', { name: 'Pin a link' });
    await expect(modal).toBeVisible();

    await modal.getByLabel('URL').fill('https://figma.com/file/abc/Design');
    await modal.getByRole('button', { name: 'Pin link', exact: true }).click();

    // Modal closes; new row uses the external_url as the display name (since
    // we didn't set a title) and shows the host in the meta line.
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
    const linkRow = drawer.getByRole('listitem', {
      name: /Attachment: https:\/\/figma\.com\/file\/abc\/Design/,
    });
    await expect(linkRow).toBeVisible();
    await expect(linkRow).toContainText('figma.com');
  });

  test('rejects a non-http(s) URL inline without submitting', async ({ page }) => {
    // The client allows both http:// and https:// (matches the server allow-
    // list); anything else (ftp:, file:, javascript:, data:) is rejected
    // inline before the multipart POST runs.
    await bootProjectPage(page);
    const drawer = await openDrawer(page);
    await openSection(drawer, 'Attachments');

    await drawer.getByRole('button', { name: '+ Pin link' }).click();
    const modal = page.getByRole('dialog', { name: 'Pin a link' });
    await modal.getByLabel('URL').fill('ftp://insecure.example.com/spec.pdf');
    await modal.getByRole('button', { name: 'Pin link', exact: true }).click();

    await expect(modal.getByRole('alert')).toHaveText(/http\(s\)/);
    // Modal still open since submission was blocked client-side.
    await expect(modal).toBeVisible();
  });
});

// =============================================================================
// 2. Comments + @mention autocomplete
// =============================================================================

test.describe('Task collaboration — comments + @mention (#311)', () => {
  test('typing @ opens autocomplete with Groups + Individuals, with @all disabled for a Member', async ({
    page,
  }) => {
    await bootProjectPage(page);
    const drawer = await openDrawer(page);
    await openSection(drawer, 'Comments');

    const textarea = drawer.getByLabel('Comment body');
    await textarea.click();
    await textarea.fill('Heads up @');

    // Listbox renders. Both groups (📅 prefix) and individuals (👤 prefix)
    // appear; we assert by accessible name on the listbox + a few option
    // sentinels rather than counting rows (member fixture has 3 individuals).
    const listbox = page.getByRole('listbox', { name: 'Mention suggestions' });
    await expect(listbox).toBeVisible();

    // Groups present (auto-groups listed unconditionally with the empty query).
    await expect(listbox.getByRole('option', { name: /@admins/ })).toBeVisible();
    await expect(listbox.getByRole('option', { name: /@scrum-team/ })).toBeVisible();
    // @all renders but is disabled because Priya is a MEMBER (role=100).
    const allRow = listbox.getByRole('option', { name: /@all/ });
    await expect(allRow).toHaveAttribute('aria-disabled', 'true');
    await expect(allRow).toContainText(/Admin\+ only/);

    // Individuals present (from /members/ fixture).
    await expect(listbox.getByRole('option', { name: /@sarah/ })).toBeVisible();
    await expect(listbox.getByRole('option', { name: /@morgan/ })).toBeVisible();
  });

  test('offers @program-* groups when the project belongs to a program (#514)', async ({
    page,
  }) => {
    await bootProjectPage(page);
    // Re-register the project-detail route (last-registered wins) so this
    // project reports a program — that is what surfaces the @program-* rows.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...FIXTURE_PROJECT, program: 'e2e-prog-514' }),
      }),
    );
    const drawer = await openDrawer(page);
    await openSection(drawer, 'Comments');

    const textarea = drawer.getByLabel('Comment body');
    await textarea.click();
    await textarea.fill('Program heads-up @program');

    const listbox = page.getByRole('listbox', { name: 'Mention suggestions' });
    await expect(listbox).toBeVisible();
    // Role-banded program group is present and enabled for a Member.
    await expect(listbox.getByRole('option', { name: /@program-pms/ })).toBeVisible();
    // @program-all renders but is Admin-gated (Priya is a MEMBER), mirroring @all.
    const programAll = listbox.getByRole('option', { name: /@program-all/ });
    await expect(programAll).toHaveAttribute('aria-disabled', 'true');
    await expect(programAll).toContainText(/Admin\+ only/);
  });

  test('selecting an individual + Cmd+Enter posts the comment with the @-mention highlighted', async ({
    page,
  }) => {
    await bootProjectPage(page);
    const drawer = await openDrawer(page);
    await openSection(drawer, 'Comments');

    const textarea = drawer.getByLabel('Comment body');
    await textarea.click();
    await textarea.fill('Can you look at this @sa');

    const listbox = page.getByRole('listbox', { name: 'Mention suggestions' });
    await expect(listbox).toBeVisible();
    await listbox.getByRole('option', { name: /@sarah/ }).click();

    // Mention chip is inserted (composer fills `@sarah ` at the caret).
    await expect(textarea).toHaveValue(/@sarah\s/);

    // Capture the POST so we can verify the body shape independently of
    // the optimistic-vs-authoritative comment row that surfaces after.
    const postRequest = page.waitForRequest(
      (req) =>
        req
          .url()
          .includes(`/projects/${PROJECT_ID}/tasks/${TASK_ID}/comments/`) &&
        req.method() === 'POST',
    );
    await textarea.press('ControlOrMeta+Enter');
    const postReq = await postRequest;
    expect(postReq.postDataJSON()).toMatchObject({
      body: expect.stringContaining('@sarah'),
      parent: null,
    });

    // The comment appears in the thread with the @-mention highlighted via
    // its `Mention: @sarah` title attribute. Bell-count update is asserted
    // separately in the notification panel tests — the unread-count query
    // is not invalidated by comment-create on purpose (it polls every 30 s).
    const newComment = drawer.getByRole('listitem', {
      name: new RegExp(`Comment by ${FIXTURE_USER.display_name}`),
    });
    await expect(newComment).toBeVisible({ timeout: 5_000 });
    await expect(newComment.getByTitle('Mention: @sarah')).toBeVisible();
  });
});

// =============================================================================
// 3. Acknowledge + react do not trigger notifications
// =============================================================================

test.describe('Task collaboration — ack/react are silent signals (#311)', () => {
  test('clicking the ack button bumps acknowledged_count but not the bell', async ({ page }) => {
    const existingComment = {
      id: COMMENT_ID,
      task: TASK_ID,
      parent: null,
      author: {
        id: 'user-sarah',
        username: 'sarah',
        display_name: 'Sarah Chen',
      },
      body: 'Please confirm we still need the on-site review.',
      edited_at: null,
      created_at: '2026-05-19T12:00:00Z',
      is_deleted: false,
      deleted_at: null,
      deleted_by: null,
      acknowledged_count: 0,
      reaction_count: 0,
      has_my_acknowledgement: false,
    };
    await bootProjectPage(page, { comments: [existingComment], unreadCount: 0 });
    const drawer = await openDrawer(page);
    await openSection(drawer, 'Comments');

    const ackButton = drawer.getByRole('button', { name: 'Acknowledge this comment' });
    await expect(ackButton).toBeVisible();
    await ackButton.click();

    // After refetch the button toggles to the "Remove your acknowledgement"
    // label and shows count "1".
    const removeAckButton = drawer.getByRole('button', { name: 'Remove your acknowledgement' });
    await expect(removeAckButton).toBeVisible({ timeout: 5_000 });
    await expect(removeAckButton).toContainText('1');

    // Bell badge is unchanged — ack never triggers a notification.
    const bell = page.getByRole('button', { name: /Notifications/ });
    await expect(bell).toHaveAccessibleName(/^Notifications$/);
  });

  test('clicking the 👍 reaction bumps reaction_count but not the bell', async ({ page }) => {
    const existingComment = {
      id: COMMENT_ID,
      task: TASK_ID,
      parent: null,
      author: { id: 'user-sarah', username: 'sarah', display_name: 'Sarah Chen' },
      body: 'Quick win — let us go.',
      edited_at: null,
      created_at: '2026-05-19T12:00:00Z',
      is_deleted: false,
      deleted_at: null,
      deleted_by: null,
      acknowledged_count: 0,
      reaction_count: 0,
      has_my_acknowledgement: false,
    };
    await bootProjectPage(page, { comments: [existingComment], unreadCount: 0 });
    const drawer = await openDrawer(page);
    await openSection(drawer, 'Comments');

    const reactButton = drawer.getByRole('button', { name: 'React with 👍' });
    await reactButton.click();
    await expect(reactButton).toContainText('1', { timeout: 5_000 });

    const bell = page.getByRole('button', { name: /Notifications/ });
    await expect(bell).toHaveAccessibleName(/^Notifications$/);
  });
});

// =============================================================================
// 4. Notification panel flow
// =============================================================================

const FIXTURE_NOTIFICATION = {
  id: 'notif-1',
  recipient: FIXTURE_USER.id,
  mention: {
    id: 'mention-1',
    mentioner: { id: 'user-sarah', username: 'sarah', display_name: 'Sarah Chen' },
    mentioned_user: {
      id: FIXTURE_USER.id,
      username: FIXTURE_USER.username,
      display_name: FIXTURE_USER.display_name,
    },
    mentioned_group_key: '',
    scope: 'individual',
    task_comment: 'c-source-1',
    created_at: '2026-05-19T12:00:00Z',
  },
  event_type: '',
  project: PROJECT_ID,
  is_read: false,
  is_archived: false,
  snoozed_until: null,
  category: 'mentions',
  created_at: '2026-05-19T12:00:00Z',
  read_at: null,
  snippet: 'Heads up — can you review the load calcs?',
  task_id: TASK_ID,
};

// Event-sourced inbox row (#497): a Confirmed schedule-canvas reschedule of a
// task this user is on. No mention; the row renders from subject/body and
// deep-links via task_id.
const FIXTURE_EVENT_NOTIFICATION = {
  id: 'notif-evt-1',
  recipient: FIXTURE_USER.id,
  mention: null,
  event_type: 'sprint.task_rescheduled',
  subject: 'Wire HVAC controls rescheduled in Sprint 4',
  body: '"Wire HVAC controls" in sprint Sprint 4 moved from 2026-10-05 to 2026-10-12.',
  project: PROJECT_ID,
  is_read: false,
  is_archived: false,
  snoozed_until: null,
  category: 'tasks',
  created_at: '2026-05-19T12:00:00Z',
  read_at: null,
  snippet: '',
  task_id: TASK_ID,
};

test.describe('Task collaboration — notification panel (#311)', () => {
  test('opens the slide-out and lists mentions', async ({ page }) => {
    await bootProjectPage(page, {
      notifications: [FIXTURE_NOTIFICATION],
      unreadCount: 1,
    });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });

    const bell = page.getByRole('button', { name: /Notifications, 1 unread/ });
    await bell.click();

    const panel = page.getByRole('dialog', { name: 'Notifications' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Sarah Chen', { exact: false })).toBeVisible();
    await expect(panel.getByText(/load calcs/)).toBeVisible();
  });

  test('clicking a notification row navigates and auto-marks read', async ({ page }) => {
    await bootProjectPage(page, {
      notifications: [{ ...FIXTURE_NOTIFICATION }],
      unreadCount: 1,
    });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });

    const bell = page.getByRole('button', { name: /Notifications, 1 unread/ });
    await bell.click();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    await expect(panel).toBeVisible();

    // The row's inner clickable is the mentioner + subject button. Filter
    // by text rather than role so we don't have to fight the wrapping
    // <article> + nested <button>.
    await panel.getByRole('button', { name: /Sarah Chen mentioned you/ }).click();

    // URL changes to the source task path. The schedule view does NOT
    // currently consume ?task=, so we don't assert the drawer re-opens —
    // only that the navigation fired.
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/schedule\\?task=${TASK_ID}`));

    // Reopen the bell — count should be 0 (auto-mark-read fired). Bell
    // changes its accessible name when count drops to 0.
    await expect(page.getByRole('button', { name: /^Notifications$/ })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('lists an event-sourced reschedule notification and deep-links to the task (#497)', async ({
    page,
  }) => {
    await bootProjectPage(page, {
      notifications: [FIXTURE_EVENT_NOTIFICATION],
      unreadCount: 1,
    });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /Notifications, 1 unread/ }).click();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    await expect(panel).toBeVisible();

    // The event row renders its own subject + body, not a mention string.
    await expect(panel.getByText('Wire HVAC controls rescheduled in Sprint 4')).toBeVisible();
    await expect(panel.getByText(/moved from 2026-10-05 to 2026-10-12/)).toBeVisible();
    await expect(panel.getByText(/mentioned/)).toHaveCount(0);

    // Deep-links to the affected task in the schedule (#497 acceptance).
    await panel
      .getByRole('button', { name: /Wire HVAC controls rescheduled in Sprint 4/ })
      .click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/schedule\\?task=${TASK_ID}`));
  });

  test('empty state shows "Caught up!" when no unread mentions exist', async ({ page }) => {
    await bootProjectPage(page, { notifications: [], unreadCount: 0 });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /^Notifications$/ }).click();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    await expect(panel).toBeVisible();
    // Default filter is "Unread"; the empty-state copy below.
    await expect(panel.getByText(/Caught up/i)).toBeVisible();
  });

  test('category selector filters the feed (ADR-0216 §3)', async ({ page }) => {
    await bootProjectPage(page, {
      notifications: [FIXTURE_NOTIFICATION, FIXTURE_EVENT_NOTIFICATION],
      unreadCount: 2,
    });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /Notifications, 2 unread/ }).click();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    await expect(panel).toBeVisible();

    // Both rows show under the default (All-category) view.
    await expect(panel.getByText(/load calcs/)).toBeVisible();
    await expect(panel.getByText('Wire HVAC controls rescheduled in Sprint 4')).toBeVisible();

    // Filter to Tasks → only the event row remains; the mention drops out.
    await panel.getByRole('radio', { name: 'Tasks' }).click();
    await expect(panel.getByText('Wire HVAC controls rescheduled in Sprint 4')).toBeVisible();
    await expect(panel.getByText(/load calcs/)).toHaveCount(0);

    // Filter to Mentions → the mention returns and the task event drops out.
    await panel.getByRole('radio', { name: 'Mentions' }).click();
    await expect(panel.getByText(/load calcs/)).toBeVisible();
    await expect(panel.getByText('Wire HVAC controls rescheduled in Sprint 4')).toHaveCount(0);
  });

  test('snoozing a row removes it from the unread view (ADR-0216 §1)', async ({ page }) => {
    await bootProjectPage(page, {
      notifications: [FIXTURE_NOTIFICATION],
      unreadCount: 1,
    });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /Notifications, 1 unread/ }).click();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/load calcs/)).toBeVisible();

    // Open the row's snooze menu and pick a preset.
    await panel.getByRole('button', { name: 'Snooze' }).click();
    await panel.getByRole('menuitem', { name: '1 hour' }).click();

    // The snoozed row leaves the default (unread) view — the friendly empty
    // state takes over — and the bell count clears (snoozed rows don't count).
    await expect(panel.getByText(/load calcs/)).toHaveCount(0);
    await expect(panel.getByText(/caught up/i)).toBeVisible();

    // It resurfaces under the Snoozed tab.
    await panel.getByRole('tab', { name: 'Snoozed' }).click();
    await expect(panel.getByText(/load calcs/)).toBeVisible();
  });
});

// =============================================================================
// 5. Notification preferences toggle (desktop table + mobile stack)
// =============================================================================

const FIXTURE_PREFERENCES = [
  {
    id: 1,
    event_type: 'mention_individual',
    channel: 'in_app',
    enabled: true,
    updated_at: '2026-05-19T12:00:00Z',
  },
  {
    id: 2,
    event_type: 'mention_individual',
    channel: 'email',
    enabled: false,
    updated_at: '2026-05-19T12:00:00Z',
  },
  {
    id: 3,
    event_type: 'mention_group',
    channel: 'in_app',
    enabled: true,
    updated_at: '2026-05-19T12:00:00Z',
  },
  {
    id: 4,
    event_type: 'mention_group',
    channel: 'email',
    enabled: false,
    updated_at: '2026-05-19T12:00:00Z',
  },
];

test.describe('Task collaboration — notification preferences (#311)', () => {
  test('desktop matrix renders 2 events × 2 channels and saves on toggle', async ({ page }) => {
    await bootProjectPage(page, { preferences: structuredClone(FIXTURE_PREFERENCES) });
    await page.goto('/me/settings/notifications');

    await expect(page.getByRole('heading', { name: 'Notification preferences' })).toBeVisible();

    // Desktop table — `hidden md:block` so it's the visible one at the default
    // viewport. Two rows: mention_individual + mention_group.
    const eventRows = page.getByRole('rowheader');
    await expect(eventRows).toHaveCount(2);

    // Headers carry the channel labels.
    await expect(page.getByRole('columnheader', { name: 'In-app' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Email' })).toBeVisible();

    // The four toggles each carry a unique aria-label combining channel + event.
    // Flip email for `mention_individual` from off → on.
    const emailToggle = page.getByRole('switch', {
      name: /Email notifications for When you're @-mentioned individually/,
    });
    await expect(emailToggle).toHaveAttribute('aria-checked', 'false');
    await emailToggle.click();

    // 300ms debounce → PATCH → "Saved." appears in the aria-live region.
    await expect(page.getByText('Saved.')).toBeVisible({ timeout: 5_000 });
    await expect(emailToggle).toHaveAttribute('aria-checked', 'true');
  });

  test('stale-task nudge toggle (ADR-0200, #646) renders data-driven and saves', async ({
    page,
  }) => {
    // The settings page is data-driven, so the stale-task row appears purely from its
    // pref rows — extend the shared fixture rather than changing it (keeps the 2-event
    // test above intact).
    const withStale = [
      ...structuredClone(FIXTURE_PREFERENCES),
      {
        id: 5,
        event_type: 'task.stale',
        channel: 'in_app',
        enabled: true,
        updated_at: '2026-05-19T12:00:00Z',
      },
      {
        id: 6,
        event_type: 'task.stale',
        channel: 'email',
        enabled: false,
        updated_at: '2026-05-19T12:00:00Z',
      },
    ];
    await bootProjectPage(page, { preferences: withStale });
    await page.goto('/me/settings/notifications');

    await expect(page.getByRole('heading', { name: 'Notification preferences' })).toBeVisible();
    // Three event rows now: two mentions + the stale-task nudge.
    await expect(page.getByRole('rowheader')).toHaveCount(3);

    // Opt into email for the stale-task nudge (off → on).
    const emailToggle = page.getByRole('switch', {
      name: /Email notifications for When a task you own goes stale/,
    });
    await expect(emailToggle).toHaveAttribute('aria-checked', 'false');
    await emailToggle.click();
    await expect(page.getByText('Saved.')).toBeVisible({ timeout: 5_000 });
    await expect(emailToggle).toHaveAttribute('aria-checked', 'true');
  });

  test('mobile viewport (375px) shows the stacked card layout instead of the table', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await bootProjectPage(page, { preferences: structuredClone(FIXTURE_PREFERENCES) });
    await page.goto('/me/settings/notifications');

    // Mobile stack uses <section aria-labelledby="pref-event-{evt}"> per event.
    await expect(
      page.getByRole('region', { name: /When you're @-mentioned individually/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: /When a group you're in is @-mentioned/ }),
    ).toBeVisible();

    // The table is `hidden md:block` so it should not be visible at 375px.
    // Use a role-scoped negative assertion to avoid the strict-mode
    // collision between the desktop table and the mobile stack (both render
    // the same toggles but at different visibility).
    await expect(page.getByRole('table')).toHaveCount(0);
  });
});
