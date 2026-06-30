# ADR-0045: User Profile Menu — /me Endpoint, Avatar Initials, Theme Toggle Migration, and Logout

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: class MeView)

## Context

The TopBar has a hardcoded `"U"` avatar placeholder with the comment `"menu deferred to auth
feature"`. No user display name, initials, or photo is shown anywhere in the app. Clicking
the avatar does nothing. Logout requires knowing to go to `/login` directly.

The app also renders a 3-way light/auto/dark theme toggle inline in the TopBar. This is an
awkward placement — the TopBar is navigation chrome, not a settings surface. The controls
belong with user preferences, not with board-level navigation.

VoC panel average: **7.2/10** (OSS signal — loved by Sarah, Priya, and Alex at the execution
layer). Every persona independently called out logout as a must-have. Dark mode as an inline
toggle (not a link to settings) was required by Sarah and Alex. Display name at the top of
the panel was the universal orientation signal.

### Baseline state discovered by code audit

| Concern | Current state |
|---|---|
| Avatar | Hardcoded `"U"` placeholder, no menu, no user data |
| User name/email on frontend | Not stored or fetched anywhere |
| `/me` endpoint | Does not exist; closest is `GET /members/?self=true` (role only) |
| Logout endpoint | Does not exist; logout is client-side `clearTokens()` only |
| JWT blacklist | `rest_framework_simplejwt.token_blacklist` not installed |
| `SIMPLE_JWT` config | Not present — all simplejwt defaults apply (access=5 min, refresh=1 day) |
| Theme persistence | `localStorage` only (`"trueppm.theme"`), not server-side |
| `UserProfile` model | Does not exist; stock `auth.User` (username, first_name, last_name, email) |

### Design questions resolved

1. **`/me` endpoint or JWT claims?** — Add `GET /api/v1/auth/me/`. JWT claims go stale
   if a user's name is updated mid-session; a lightweight endpoint is more correct and
   consistent with the API-first principle.

2. **Profile photo storage?** — Defer entirely from v1. Initials-only avatar is sufficient.
   Photo upload requires object storage decisions (local media vs. S3) and a separate design
   review. Initials cover the orientation and identity use-cases VoC described.

3. **Dark mode: localStorage or server-side?** — Keep localStorage for v1. The preference
   lives in `themeStore.ts` already; adding a server round-trip for theme persistence adds a
   model, a migration, and cache-invalidation complexity for marginal gain. Flag as a v2
   enhancement once a broader user-preferences model is warranted.

4. **Theme controls in TopBar — remove?** — Yes. The 3-way toggle in the TopBar is
   topographically wrong: theme is a user preference, not navigation chrome. Moving it into
   the profile dropdown and removing it from the TopBar reduces noise and locates the control
   where all six personas intuitively expect it. The `'auto'` (system) mode is preserved.

5. **Notifications page in scope?** — No. The notifications row in the dropdown is a stub
   link. `/settings/notifications` does not exist; build it when the notification model is
   designed (see ADR-0037 open question #4 and ADR-0020).

6. **Logout: client-side or server blacklist?** — Client-side for v1. `clearTokens()` +
   redirect to `/login` is the existing mechanism. Token blacklisting requires installing
   `rest_framework_simplejwt.token_blacklist`, a Django migration, periodic outbox cleanup,
   and a new endpoint — disproportionate complexity for the access token lifetime (5 min
   default). Marcus's "sign out all devices" requirement is an Enterprise concern (audit
   trail, SSO). Mark as a v2 / Enterprise extension point.

7. **Keyboard shortcuts modal?** — Include the row as a stub trigger. The modal content
   (shortcut reference list) is a separate deliverable; the row signals the feature exists.

## Decision

### V1 scope

**API (OSS — packages/api):**
- Add `GET /api/v1/auth/me/` returning `{id, username, display_name, initials, email}`.
  - `display_name` = `"{first_name} {last_name}".strip()` falling back to `username`
  - `initials` = first letter of `first_name` + first letter of `last_name` (or first two
    letters of `username` if no name is set), uppercased, max 2 chars
  - Requires authentication. No `server_version` (read-only, no sync needed).
  - Public role is intentionally omitted — role is project-scoped and already available
    via `GET /projects/{id}/members/?self=true`. Mixing project-scoped role into a
    global `/me` would be misleading.

**Web (OSS — packages/web):**
- Remove `THEME_BUTTONS` array and the theme toggle group from `TopBar.tsx`.
- Replace the `"U"` placeholder `<button>` with a `<UserMenu>` component.
- `useCurrentUser()` hook: `GET /api/v1/auth/me/`, cached with `staleTime: 5 * 60 * 1000`
  (5 minutes — matches default access token lifetime), public-axios-free (uses `apiClient`).
- `<UserMenu>` renders:
  1. **Avatar chip** — `{initials}` on `bg-brand-primary`, `w-8 h-8 rounded-full`, `text-xs font-semibold`
  2. Clicking the chip opens a `role="menu"` dropdown anchored to the chip.
  3. **Dropdown header** (non-interactive): display name (bold), username/email (secondary, truncated).
  4. **Theme toggle row** — inline 3-way: Light / Auto / Dark. Writes to `themeStore`. No page reload.
  5. **Notifications** — `role="menuitem"`, stub link to `/settings/notifications` (renders 404 until built). Shows unread count badge when the notification system ships.
  6. **Keyboard shortcuts** — `role="menuitem"`, triggers a `<KeyboardShortcutsModal>` (stub for now — modal renders a "coming soon" placeholder).
  7. **Divider**
  8. **Sign out** — `role="menuitem"`, calls `clearTokens()`, clears TanStack Query cache, redirects to `/login`.
- `<UserMenu>` is `hidden` (no render) until `_hasHydrated` is true — prevents flash of wrong state on first load.
- On `auth:sessionExpired` custom event (existing interceptor in `client.ts`): auto-redirect to `/login?next=current_path`.

### Out of scope for v1

- Profile photo upload (storage decision deferred)
- Server-side theme persistence (add to `/me` PUT when a broader user-prefs model is designed)
- `/settings/notifications` page content
- JWT token blacklisting / "sign out all devices" (Enterprise extension point)
- SIMPLE_JWT lifetime tuning (separate hardening ticket; see `remember_me` in wave8-login)
- Password change flow (allauth-backed, separate page)

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Embed display name in JWT claims | Zero extra network call; name available immediately | Stale if user updates name mid-session; requires custom `TokenObtainPairSerializer` |
| `GET /api/v1/auth/me/` (chosen) | Fresh name; API-first; no JWT customisation; consistent with existing query patterns | One additional GET on first render (mitigated by 5-min stale cache) |
| Add `first_name`/`last_name` to `/members/?self=true` | Reuses existing endpoint | Confuses user identity with project membership; breaks SRP |
| Server-side JWT blacklist for logout | Correct token revocation; satisfies Marcus | Requires migration, drain task, periodic cleanup; over-engineered for access token TTL of 5 min |
| Keep TopBar theme toggle, also add to profile menu | Redundancy | Two places to change theme creates confusion about which is canonical |

## Consequences

**Easier:**
- Logout is discoverable for every persona — no hunting
- TopBar is simpler — navigation chrome only, no settings controls mixed in
- Dark mode preference is colocated with all other user preferences
- `/me` establishes the pattern for future user-preference endpoints

**Harder / Risks:**
- `GET /api/v1/auth/me/` fires on every authenticated page load (mitigated by 5-min stale time)
- Removing the TopBar theme toggle will break any existing E2E tests that locate those buttons — must be updated in the same MR
- Initials fallback on empty `first_name`/`last_name` (username-only accounts from dev seeds) must be handled client-side

## Implementation Notes

- **P3M layer**: Operations / Programs and Projects — individual user session and personal preference management. OSS core.
- **Affected packages**: `api`, `web`
- **Migration required**: No — no new model. `GET /api/v1/auth/me/` reads from stock `auth.User`.
- **API changes**: Yes — new endpoint `GET /api/v1/auth/me/` (see above). OpenAPI schema must be regenerated.
- **OSS or Enterprise**: OSS (`trueppm-suite`). "Sign out all devices" and SSO session termination are Enterprise extension points.

### Durable Execution

1. **Broker-down behaviour**: N/A — `/me` is a read endpoint; `UserMenu` actions (theme toggle, logout) are synchronous client-side operations with no async side effects.
2. **Drain task**: N/A — no async work dispatched.
3. **Orphan window**: N/A.
4. **Service layer**: N/A — logout calls `clearTokens()` directly; no service dispatch.
5. **API response on best-effort dispatch**: N/A — `GET /api/v1/auth/me/` is synchronous; logout is client-side.
6. **Outbox cleanup**: N/A.
7. **Idempotency**: N/A — read endpoint; client-side logout is idempotent by nature.
8. **Dead-letter / failure handling**: N/A — if `/me` returns 401 the existing `apiClient` interceptor triggers `clearTokens()` and redirects to `/login`. No dead-letter path needed.

## Tracking

Tracking: implemented in #246 (User profile menu — initials avatar, theme toggle
migration, and logout).
