# ADR-0410: Per-user timezone and date-format display preferences

## Status
Proposed

## Context
Issue #1953 (OSS) asks for two personal display preferences — an IANA
**timezone** and a **date format** — so timestamps and dates render in a frame the
viewer recognizes instead of UTC or an implicit `en-US` browser render. Project
teams are globally dispersed: a contributor in Sydney reads an activity stream in
an implicit zone and a US month-day-year format they don't recognize. Today every
displayed datetime is either UTC-pinned or formatted with an ad-hoc
`toLocaleDateString('en-US', …)` call that silently uses the browser's zone with no
user control and no consistency (~47 call sites).

Precondition facts (verified 2026-07-14):

- **Backend is aware-UTC end to end.** `settings/base.py` sets `TIME_ZONE="UTC"`,
  `USE_TZ=True`; the ORM and `timezone.now()` are aware-UTC. All API datetimes are
  emitted as aware-UTC ISO-8601. Localization has never been a server concern and
  this ADR keeps it that way (Nadia's API invariant).
- **Prefs already have a home.** `apps/profiles/models.py::UserProfile` (ADR-0129)
  is the per-user singleton — not a `VersionedModel`, not synced, not broadcast,
  lazily `get_or_create`d. It already carries string-sentinel prefs
  (`default_landing="auto"`, `role_context="unified"`). Read path:
  `services.get_profile_prefs()` → `MeSerializer._prefs()` → `GET /auth/me/`; write
  path: `UserProfileSerializer.update()` (explicit field-by-field) → `PATCH
  /auth/me/profile/`.
- **IANA validation has a precedent.** `TaskRecurrenceRule.validate_timezone`
  (projects/serializers.py) validates via stdlib `zoneinfo.ZoneInfo(value)` in a
  try/except. `Calendar.timezone`, `Project.timezone`, `Workspace.timezone` follow
  the same pattern. No pytz anywhere.
- **The calendar-date path is a single mandated chokepoint.** `lib/formatUtcDate.ts`
  (`fmtUtcShort`/`fmtUtcLong`) hardcodes `timeZone: 'UTC'` per ADR-0144 /
  web-rule 189, and web-rule 189 **requires** every forecast/CPM/calendar date to
  route through it. That "one chokepoint already exists" is the lever this ADR
  pulls (see Decision §3).
- **Relative times** (`lib/formatRelative.ts`) compute `m/h/d ago` from pure elapsed
  math (tz-independent) but fall back to a *local* `toLocaleDateString` for
  anything older than a week.

Companion bugfix **#1952** (separate branch/MR **!1313**, already open) sets
`Formatter.converter = time.gmtime` on the log formatters so server log
`asctime`/timestamps render UTC instead of container-local. It is the
**server-side complement** of the same principle this ADR encodes — *the server
never localizes; instants are stored and emitted in UTC; localization is a pure
client concern*. The two are orthogonal (log rendering vs. user display), ship on
separate branches, and share no code.

VoC (avg 5.7; the sub-6 is pure persona-orthogonality — David 🔴 is the documented
pre-0.5 allocation NO, Janet/Jordan/Alex simply aren't the audience for a personal
display setting; the in-domain personas rate it well: Morgan 8, Omar 8, Nadia 7,
Marcus 7; **no design 🔴**). Actionable inputs folded into this design: Priya —
zero settings-page hunt (auto-detect) and a crisp instant-vs-date split near tz
boundaries; Morgan — strictly personal, never a PMO/team-admin surface; Nadia —
additive/non-breaking, 400 on bad tz/format, `date_format` is an additive
non-closed enum and a display-only hint agents ignore, all API datetimes stay
aware-UTC, agent-actor computed responses are never reformatted by a human's
profile; Marcus — the PATCH is captured in request logging, audit/exports stay UTC;
Omar — call the log-timestamp source change out in the #1952 changelog.

## Product decision that shapes this ADR

**The date *format* applies to every displayed date; the *timezone* re-clocks only
instants.** (User decision, 2026-07-14, over the architect's narrower
instants-only default.) Reformatting a UTC calendar date's *style* (`2026-08-19`
vs `Aug 19` vs `19 Aug`) is timezone-independent — the day never moves — so an EU
user should see their format on the Gantt and the forecast bar too, not only in the
activity feed. Re-*timezoning* a calendar date is still always wrong (it shifts the
displayed day per viewer — the ADR-0144 bug), so timezone stays pinned to UTC for
calendar dates. This splits the two preferences onto two different scopes, and that
split is the heart of this ADR.

## Decision

### 1. Two preferences, two scopes — the central rule

| Preference | Applies to | Never applies to |
|---|---|---|
| **timezone** (re-clock) | **instants** only (values with a time-of-day) | calendar dates (date-only) — they stay UTC |
| **date_format** (re-style) | **all** displayed dates — instants *and* calendar dates | — (it is timezone-independent, always safe) |

One mechanical guardrail decides "instant vs calendar date" by **wire shape /
serializer field type**, not by reading intent:

> **A value that carries a time-of-day (`2026-07-14T09:32:00Z`, from a
> `DateTimeField`) is an *instant*: re-clock it to the user's timezone AND style it
> with the user's date format. A value that is date-only (`2026-07-14`, from a
> `DateField`) is a *calendar date*: keep it UTC-pinned (never re-clock) but style
> it with the user's date format.**

**Instants (timezone + format):** activity/audit stream timestamps; comment
created/edited timestamps; task `created_at`/`updated_at`; relative "5m ago" and its
`>7d` fallback; notification times; timer / time-entry `created_at`/`logged_at`.

**Calendar dates (UTC-pinned, format only):** forecast P50/P80/P95, CPM early/late
start & finish; task planned/actual start & finish **dates**; baselines; calendar
working-days; sprint start/end **dates**; a time entry's **work-date** column.

**Ambiguous cases resolved by the guardrail:**
- *Due date vs. due datetime* — TruePPM task due dates are `DateField` → **calendar
  date** (UTC-pinned, reformatted). If a field ever becomes a `DateTimeField` with a
  real deadline time-of-day it flips to instant automatically. Follow the field
  type, not the word "due".
- *A time-entry row* — the sharp case, resolved cleanly: the **work-date** column is
  a calendar date (UTC-pinned, reformatted); the same row's **"logged 5m ago"** is
  an instant (re-clocked + reformatted). Both correct under one rule.

### 2. Model + validation

Two additive fields on `UserProfile`, both string sentinels defaulting to `"auto"`
(matching the model's own `default_landing`/`role_context` idiom):

```python
class DateFormat(models.TextChoices):
    AUTO = "auto", "Automatic (based on your locale)"
    ISO = "iso", "2026-07-14"          # YYYY-MM-DD
    US = "us", "Jul 14, 2026"          # MMM D, YYYY
    EU = "eu", "14 Jul 2026"           # D MMM YYYY

# on UserProfile:
timezone = models.CharField(
    max_length=64, default="auto",
    help_text=("IANA timezone for displaying instant timestamps, or 'auto' to use "
               "the browser's detected zone. Display-only; API datetimes stay UTC."),
)
date_format = models.CharField(
    max_length=8, choices=DateFormat.choices, default=DateFormat.AUTO,
    help_text="Date-format style for all displayed dates. 'auto' follows browser locale.",
)
```

Rationale for the `"auto"` sentinel on `timezone` (not nullable, not a bare
`"UTC"`): it is byte-identical to the model's existing idiom, and it is what makes
Priya's zero-config work — `"auto"` resolves *client-side* to
`Intl.DateTimeFormat().resolvedOptions().timeZone`, so display is already correct in
the viewer's zone on first load with **no write and no settings visit**. The
settings page is override-only (a traveler pinning a home zone). A bare `"UTC"`
default could never distinguish "chose UTC" from "never configured", so it could
never fall back to the browser zone. The server has no browser, so server-side
`"auto"` trivially resolves to UTC.

**Validation** (`UserProfileSerializer.validate_timezone`), reusing the
`TaskRecurrenceRule` precedent verbatim — `ZoneInfo(value)` try/except, **not**
`available_timezones()` membership (matches the codebase and accepts exactly the OS
tzdata strings `Intl…timeZone` emits); `"auto"` is accepted early. `date_format`
needs no custom validator — model `choices` reject an out-of-range value with a
DRF-standard 400 field error (Nadia's ask).

**Migration:** one additive migration, both fields defaulted, **no backfill**
(lazy rows; absent row reads as defaults via `get_profile_prefs`). Standard recipe
(`makemigrations` → `ruff check --fix && ruff format` on the migration); run
`migration-check`.

**Wiring (all additive):** `UserProfileSerializer.Meta.fields` += `["timezone",
"date_format"]` + two `update()` branches; `get_profile_prefs` returns a 6-tuple
(extend `.only()`, the `None`-row fallback to `(…, "auto", "auto")`, and the type
hint); `MeSerializer` gains two `SerializerMethodField`s reading the new tuple
slots; regenerate OpenAPI (`scripts/export-openapi.sh`, pre-commit hook re-stages;
`api-docs` agent for the `docs/api/` diff).

### 3. Frontend architecture — two format-aware chokepoints, one hook

The two scopes map to the two existing formatting paths, **both made
format-aware**, both fed the user's resolved prefs from **one** hook.

**(a) Instant chokepoint — new `lib/formatUserDateTime.ts` (pure fns):**

```ts
export interface ResolvedDatePrefs { timeZone: string; dateFormat: DateFormatStyle }

// The SINGLE place "auto" collapses to concrete Intl inputs. Pure; no browser needed
// in tests when both args are concrete.
export function resolveUserDatePrefs(timezone: string, dateFormat: string): ResolvedDatePrefs;

// INSTANTS: re-clock to prefs.timeZone AND style by prefs.dateFormat.
export function formatInstant(iso, p): string;       // date + time
export function formatInstantDate(iso, p): string;   // date part, in tz
export function formatInstantTime(iso, p): string;   // time part, in tz
```

`resolveUserDatePrefs` resolves `timezone==="auto"` →
`Intl.DateTimeFormat().resolvedOptions().timeZone`, and `dateFormat==="auto"` →
browser-locale medium date. The three explicit styles map to fixed `Intl` option
objects (ISO assembled from parts; US = `en-US` medium; EU = `en-GB`-style
`D MMM YYYY`).

**(b) Calendar-date chokepoint — `lib/formatUtcDate.ts` becomes format-aware but
stays UTC-pinned.** This is the format-everywhere lever. `fmtUtcShort`/`fmtUtcLong`
gain an **optional** `dateFormat?: DateFormatStyle` parameter; `timeZone: 'UTC'`
stays hardcoded and is never parameterized (the ADR-0144 invariant is *timezone*,
which is untouched). To make the format apply **everywhere the ~40 existing
forecast/calendar call sites already route through this file** (web-rule 189)
without converting each call site, the functions default their style to a
**module-level `activeDateFormat`** that AppShell keeps in sync with the user's
preference:

```ts
let activeDateFormat: DateFormatStyle = 'us';           // current behavior preserved
export function setActiveDateFormat(f: DateFormatStyle) { activeDateFormat = f }
export function fmtUtcShort(iso, dateFormat = activeDateFormat): string { /* timeZone:'UTC' */ }
```

- **Default preserved:** with `activeDateFormat` unset (`'us'`), every existing call
  is byte-identical to today — no call site breaks, ADR-0144 output is unchanged for
  a US/auto user.
- **Everywhere, cheaply:** a one-line effect in `AppShell` calls
  `setActiveDateFormat(resolvePrefs(user).dateFormat)` whenever `useCurrentUser`
  changes, so every forecast/CPM/Gantt date already funneling through
  `formatUtcDate` picks up the user's style with **zero call-site edits**. Timezone
  in that file never changes.
- **Reactivity nuance (accepted):** a module variable does not itself trigger React
  re-renders, so a *preference change* live-updates a surface on its next
  render/navigation, not instantly, for sites still calling the bare function. The
  marquee surfaces converted in MVP (§4) use the reactive hook and update
  instantly; format changes are rare and a navigation fully propagates. This is a
  deliberate, documented trade to get "everywhere" in one MR without a 47-site
  churn. (First render already reflects the preference: `useCurrentUser` resolves
  before data-driven surfaces paint.)

**(c) One hook binds both to the current user** — `hooks/useUserDateFormat.ts`:

```ts
export function useUserDateFormat() {
  const { user } = useCurrentUser();
  const prefs = resolveUserDatePrefs(user?.timezone ?? 'auto', user?.date_format ?? 'auto');
  return {
    formatInstant:  (iso) => formatInstant(iso, prefs),      // tz + format
    formatInstantDate: (iso) => formatInstantDate(iso, prefs),
    fmtDateShort: (iso) => fmtUtcShort(iso, prefs.dateFormat), // UTC-pinned, format
    fmtDateLong:  (iso) => fmtUtcLong(iso, prefs.dateFormat),
  };
}
```

Reactive surfaces call the hook; the module default (b) covers the unconverted long
tail. `CurrentUser` gains `timezone: string` and `date_format: DateFormatStyle`.

**`formatRelative`** — the `m/h/d ago` branches are tz-independent and stay as-is;
only the `>7d` `toLocaleDateString` fallback takes an **optional** `prefs?` param
(omitted = unchanged), routed through the chokepoint on converted surfaces.

**Auto-detect UX — override-only, no silent write.** Because `"auto"` already
resolves to the browser zone at render time, display is correct out of the box. The
settings control's first option is `Automatic — detected: {browser zone}` (label
shows the resolved zone inline); selecting a concrete zone/style is the only write.

### 4. MVP scope vs. follow-up

**MVP — one reviewable MR (no half-converted surface):**
1. Model: 2 fields + migration + serializer/services/`MeSerializer` wiring + OpenAPI
   + `CurrentUser` type.
2. Settings UI: `TimezoneFormatSection.tsx` on `MyGeneralPreferencesPage`
   (`ViewVisibilitySection` template — per-change auto-save, optimistic +
   revert-on-error, aria-live "Saved."). Timezone searchable select (`auto` option
   + `Intl.supportedValuesOf('timeZone')`) and date_format select **with a live
   sample rendered for the currently-hovered/selected style**. New hooks
   `useUpdateTimezone` / `useUpdateDateFormat` (PATCH `/auth/me/profile/`, invalidate
   `['current-user']`).
3. Chokepoints: `formatUserDateTime.ts` + `resolveUserDatePrefs`; make
   `formatUtcDate.ts` format-aware (optional param + `activeDateFormat` module
   default + `setActiveDateFormat`); `useUserDateFormat` hook; the `AppShell`
   sync-effect.
4. Convert the **instant marquee surfaces** to the reactive hook completely —
   activity/audit stream (`ActivityTimeline`) and comments (`CommentSection`),
   whose timestamps re-clock to the user's zone + format (and whose `>7d`
   relative fallback routes through the chokepoint). This is the scope where a
   wrong *zone* is most visible.
5. **Calendar-date "format everywhere" ships via the module default (b), not
   per-surface conversion.** Because web-rule 189 already funnels every
   forecast/CPM/schedule/Gantt date through `formatUtcDate`, `AppShell`'s
   `DisplayFormatSync` setting `activeDateFormat` makes all ~20 of those surfaces
   reflect the user's *format* with **zero call-site edits** — so "format
   everywhere" is *observably* true at ship. Per-surface conversion of those
   calendar callers to the reactive hook is unnecessary in practice: the settings
   page and the schedule are different routes, so a format change always lands via
   a remount/navigation (there is no simultaneous-view scenario); the marquee
   instant surfaces that *are* co-viewable use the reactive hook.

**Follow-up issue** ("migrate remaining instant-display sites to
`formatUserDateTime`"): the ~40 other ad-hoc `toLocaleDateString` **instant** sites
(notification detail, misc created/updated labels, timer stamps outside the
timesheet). These are timezone-wrong today and are mechanical one-line conversions
to `useUserDateFormat().formatInstant`. Calendar dates need no follow-up — the
module default already covers them. The MVP line is drawn at **whole surfaces**.

### 5. Guardrail (new web-rule)

Add to `packages/web/CLAUDE.md`:

> **Timezone re-clocks instants; the date format restyles every date; a calendar
> date is never re-timezoned.** A datetime with a time-of-day (`…THH:MM:SSZ`, from a
> `DateTimeField`) is an *instant* — format it via `useUserDateFormat().formatInstant`
> (re-clocked to the user's zone AND styled by their date format). A date-only value
> (`YYYY-MM-DD`, from a `DateField`) is a *calendar date* — format it via
> `formatUtcDate` / `useUserDateFormat().fmtDate*` (UTC-pinned per ADR-0144/rule 189,
> but styled by the user's date format). Never apply a user timezone to a calendar
> date; never UTC-pin an instant. The date *format* (ISO/US/EU) applies to both; the
> *timezone* applies to instants only. Pick the path by the wire shape, not the
> field's name.

## Consequences

**Positive:** zero-config correct display (`auto` default resolves to the browser
zone); the user's format reaches every date — activity feed *and* Gantt/forecast —
matching "a format recognizable to them"; one enforceable guardrail kills the
instant/calendar drift class; additive & non-breaking for API and sync (datetimes
stay aware-UTC ISO; `date_format` is a display-only non-closed hint an agent
ignores); strictly personal, no governance surface (Morgan); reuses the exact
model/serializer/validation grooves; the format-everywhere win costs ~zero call-site
churn because web-rule 189 already funnels calendar dates through one file; agent
computed responses are never reformatted (localization lives only in the web
client).

**Risks / mitigations:**
- *Preference change not instantly live on unconverted calendar sites* — accepted;
  next render/navigation propagates it, marquee surfaces are reactive, format changes
  are rare (documented in §3b).
- *Half-converted instant surface* — mitigated by the whole-surface MVP line + the
  follow-up checklist.
- *`auto` differing across a user's devices* — expected; pin an explicit zone for
  stability. Not a bug.
- *`Intl.supportedValuesOf` absent on an ancient browser* — degrade to a short
  curated fallback list; `auto` still works (`resolvedOptions`).
- *Reviewer applies the user tz to a calendar date* — the new web-rule + the
  UTC-pinned `formatUtcDate` (timezone never parameterized) make the correct path the
  only one; call it out in the MR.
- *Server ever needs to render user-local time* (e.g. a notification email body) —
  out of scope; server stays UTC. If it arises, it reads `profile.timezone` and
  resolves `auto`→UTC server-side.

## Relationship to #1952
#1952 (log formatter `converter = time.gmtime`, MR !1313) and this ADR both encode
*the server emits/stores UTC; localization is a client concern*. Orthogonal, separate
branches, no shared code, independent land order.

## References
- ADR-0129 — role-based app landing (introduced `UserProfile`)
- ADR-0139 — per-user view visibility (`hidden_views`, section template)
- ADR-0144 / web-rule 189 — UTC-pinned forecast/calendar dates (`formatUtcDate.ts`)
- ADR-0203 / #1645 — `schedule_in_deliver` (per-user display-only pref precedent)
- Issue #1953 (this ADR); companion bugfix #1952 / MR !1313
