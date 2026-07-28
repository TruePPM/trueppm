# ADR-0682: Section-level context-sensitive help in Settings

## Status
Accepted

## Context

TruePPM Settings has help at two altitudes and a hole between them.

**Field altitude** is solved. Rule 263 gives every jargon-carrying input a circled ⓘ
(`components/FieldHelp.tsx`) whose popover ends in a `Learn more →` deep link built with
`docsUrl()` (rule 212). The behavior is documented for users at
`administration/workspace-settings.md#in-product-help`.

**Page altitude** is solved trivially: `SettingsPageTitle` renders a title and a one-line
subtitle for every section.

**Section altitude is not solved.** A user standing on Project → Settings → General, or
Access, or Program → Settings → anything, can read a 13px subtitle and open a ⓘ on whichever
individual fields happen to carry jargon — but has no route to the page that documents the
section as a whole. `administration/project-settings.md` and
`administration/program-settings.md` describe those sections in depth and are, from inside
the product, unreachable.

Where section-level help exists today it is ad-hoc: six sections out of roughly forty-four,
in four visual forms, implemented by two separately-defined local `LearnMoreLink` components
(`WorkspaceDangerPage.tsx:31`, `ProjectArchivePage.tsx:62`), one local `DocLink`
(`ProjectIntegrationsPage.tsx:78`), and two one-off buttons (`WorkspaceSsoPage.tsx:210`,
`systemHealth/TelemetryCard.tsx:600`). Because there is no shared affordance, every new
settings section starts from zero — and the 6/44 ratio shows what that produces by default.

Program scope has zero section-level help across all eleven sections. The sharpest case is
`ProgramIntegrationsPage.tsx`: the direct twin of the project Integrations page, same three
child components, but the project page's "New to integrations? See the docs on…" line is
simply absent. Identical surface, different help, for no reason a user could infer.

The forces:

- **The anchors mostly already exist.** `program-settings.md` carries a `##` heading for
  every program section; dedicated admin pages exist for most workspace sections. The docs
  were written and never linked. The remaining gaps (`project-settings.md` covers ~6 of 15,
  `workspace-settings.md` ~4 of 18) are bounded.
- **Coverage decays silently.** Whatever we build, the failure mode is a new section
  shipping without help and nobody noticing for a release. Review has already failed this
  test 38 times.
- **A broken deep link is worse than no link.** Section help that 404s or lands on a heading
  that no longer exists actively costs trust.
- **The diff must not be 44 files wide.** A change that requires touching every section
  component to add one prop will be partially applied, and the parts that are missed are
  invisible.

## Decision

**One shared affordance, resolved by the shell from a single enumerable map, with coverage
and anchor-resolution both enforced by tests rather than by review.**

Four parts:

1. **A single source of truth for the mapping.** A new
   `packages/web/src/features/settings/settingsDocs.ts` exports
   `SETTINGS_DOCS: Record<SettingsScope, Record<string, string>>` — section id → docs-site
   slug, e.g. `project.general → 'administration/project-settings/#general'`. One reviewable
   file that shows the whole help surface at a glance, instead of 44 props scattered across
   44 components.

2. **The shell resolves it; sections stay untouched.** `SettingsShell` already receives a
   `scope` prop (`SettingsShell.tsx:73`). It provides that scope on a new context;
   `SettingsSection` — which already knows its `id` — looks up `SETTINGS_DOCS[scope][id]`
   and provides the resolved href on a second context; `SettingsPageTitle` consumes it and
   renders the link. **No section component and no `<SettingsSection>` mount site changes.**
   `SettingsPageTitle` also accepts an explicit `docsHref` prop that wins over context, for
   the standalone tool pages (`SystemHealthOverviewPage`) that render outside a
   `SettingsSection`.

3. **The affordance is a text link trailing the subtitle, not a control in the action slot.**
   Rule 287 forbids an icon-only control without a `Tooltip`, and rule 121 makes a link
   inside a hover tooltip unreachable — so the honest form is a labelled link. It carries the
   rule-4 `focus-visible` ring (rule 118: navigating anchors keep `focus-visible:`, since a
   clicked link does not retain focus), `target="_blank"`, `rel="noopener noreferrer"`, and
   an `(opens in a new tab)` screen-reader suffix, matching the richest existing precedent
   (`WorkspaceDangerPage.tsx:32-43`).

   The `ux-design` gate placed it at the **tail of the subtitle line**, not in the title
   strip's right-hand `shrink-0` slot as this ADR first assumed. Two measurements decided it:
   16 of the 67 `SettingsPageTitle` call sites already pass `action` for a primary control
   ("Add member", "New label", "Force refresh"), so the right slot is contested and putting
   secondary help beside a primary action inverts the hierarchy on a quarter of sections; and
   54 of 67 carry a subtitle, so trailing that sentence gives the link a consistent home that
   reads as prose rather than as a 44-instance chrome band. Sections with no subtitle render
   the link in the subtitle's own slot. The `action` slot is left entirely alone, which also
   removes the composition problem this ADR originally had to solve.

   Link text is `Learn more →` with a specific accessible name — `Learn more about
   {title} (opens in a new tab)` — because 44 identically-named "Learn more" links would fail
   WCAG 2.4.4 (Link Purpose) in the accessibility tree even though each is visually
   unambiguous in place. `SettingsPageTitle` already has `title` in scope, so specificity is
   free.

4. **Two guard tests, because two different things rot.**
   - *Coverage*: iterate the three nav builders; assert every nav item id has a
     `SETTINGS_DOCS` entry for its scope, and that no map key is an orphan. A new section
     cannot ship helpless.
   - *Resolution*: for every slug in the map, read `packages/website/src/content/docs/` from
     disk and assert the file exists and, when the slug carries a `#fragment`, that a heading
     slugifying to that fragment exists in it. A renamed heading fails the web suite, in the
     repo where the rename happened.

The six ad-hoc links are folded into the shared affordance and their three local components
deleted. Per-card links inside Danger and Lifecycle stay — a destructive card is genuinely
its own subject, and rule precedent (`WorkspaceDangerPage.tsx:26-29`) is explicit that the
whole action, not a field, is what needs explaining there. The section link is additive.

`FieldHelp` is untouched. The two answer different questions: field help answers "what are my
choices for this input", section help answers "what is this page and where is it documented".

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Shell resolves from a central map (chosen)** | Zero diff across 44 section components and 3 mount lists; whole help surface reviewable in one file; coverage test is a trivial iteration over nav builders; new section is help-covered or the suite fails | Adds two React contexts; the map is one more indirection between a section and its link |
| B. `docsHref` prop on each section's `SettingsPageTitle` | Most explicit — the link sits next to the title it belongs to; no context plumbing | 44-file diff that will be partially applied; coverage cannot be enumerated without grepping components, so the guard test degrades to a lint hack |
| C. Required `docsHref` on `SettingsNavItem` | TypeScript alone enforces coverage — strongest possible guarantee, no coverage test needed | Nav items are the *rail*; the link renders in the *section*, so the shell must thread nav data into `SettingsSection` anyway. Also breaks the route-link items (`to`) and the off-route shells that reuse the workspace builder with `linked: true` |
| D. Keep ad-hoc links, just add the missing ones | Smallest possible change | Leaves four visual forms and three duplicate components; regenerates the exact 6/44 decay in two releases. This is the status quo that produced the bug |
| E. In-app help panel / embedded docs viewer | No context switch out of the product | Violates rule 212 (canonical published docs site); large surface; duplicates content that already exists and would immediately drift |

Option C is the one worth regretting — compile-time coverage beats a test. It was rejected on
the `linked: true` off-route shells and the `to`-carrying route items, which are nav entries
without a corresponding in-page section; making the field required would force meaningless
hrefs on them. The coverage test recovers most of C's guarantee at runtime.

## Consequences

**Easier**
- Every settings section gains a route to its documentation, including all eleven program
  sections that had none.
- Adding a section is a two-line change (nav item + map entry) and the suite tells you if you
  forget the second.
- The four competing visual forms collapse to one; three duplicate local components are
  deleted.
- Renaming a docs heading now fails a test instead of silently producing a dead in-product
  link.

**Harder**
- The link for a given section is no longer visible in that section's own file — a reader has
  to open `settingsDocs.ts`. Mitigated by that file being the point: one place to see the
  whole surface.
- The docs repo and the web package are now coupled by the resolution test. That coupling is
  deliberate — it is the thing that keeps the links honest — but it means a docs restructure
  must update the map in the same MR.

**Risks**
- *Docs gaps become blocking.* `project-settings.md` and `workspace-settings.md` lack `##`
  anchors for roughly two dozen sections; the resolution test will not pass until they are
  written. Accepted: this is the work, not an obstacle to it. Where a section has no
  meaningful documentation yet, the map points at the parent page without a fragment rather
  than at an invented anchor.
- *Slug drift between Astro's slugifier and the test's.* The test must slugify headings the
  same way Starlight does (lowercase, non-alphanumerics to hyphens, collapse runs). A
  mismatch produces false failures. Mitigated by covering the slugifier itself with unit
  tests over the real heading strings in the three settings docs.
- *Visual noise.* Forty-four sections each gaining a right-aligned link risks reading as
  chrome. Mitigated by the `ux-design` gate, which owns the final weight and placement.

## Implementation Notes

- **P3M layer**: Programs and Projects, plus workspace administration. No cross-program or
  portfolio aggregation.
- **Affected packages**: `web` (settings shell, nav builders, section pages), `website`
  (docs anchors). Not `api`, not `scheduler`, not `mobile`, not `helm`.
- **Migration required**: no — no model touched.
- **API changes**: no. The mapping is static frontend configuration; nothing about it is
  server state, so ADR-0599's API-first rule on *authoritative* state does not engage.
- **OSS or Enterprise**: OSS. Settings for a workspace, program, and project are the
  adoption surface; help on them is table stakes. The enterprise registry slot on the
  Integrations pages is untouched and keeps rendering its own content.

### Durable Execution

1. **Broker-down behaviour**: N/A — the change is a static string map, two React contexts,
   and one anchor element. There is no dispatch, no task, and no write path of any kind.
2. **Drain task**: N/A — no async work introduced, so nothing to drain.
3. **Orphan window**: N/A — no outbox rows, no `transaction.on_commit()` callbacks.
4. **Service layer**: N/A — no backend call is made. The link is a plain `<a>` to the
   published docs site; the app performs no request on its behalf.
5. **API response on best-effort dispatch**: N/A — no endpoint is added or changed.
6. **Outbox cleanup**: N/A — no outbox rows are written.
7. **Idempotency**: N/A — no task exists. Rendering is a pure function of `(scope, sectionId)`
   against a frozen constant map, so it is trivially repeatable and side-effect free.
8. **Dead-letter / failure handling**: N/A for async. The one failure mode that does exist is
   a *stale* map entry pointing at a heading that has been renamed or deleted, and it is
   handled at build time rather than at runtime: the resolution test fails the web suite
   before the change can merge. At runtime a missing map entry degrades to rendering no link
   — the section loses its help affordance but never crashes and never renders a dead href.
