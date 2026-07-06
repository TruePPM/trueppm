# ADR-0264: External stakeholder registry for @program-stakeholders

## Status
Accepted

## Context
`@program-stakeholders` (ADR-0075 §C / ADR-0240, #514) resolves to the **exact
Viewer-role** members across a program's projects — the view-only audience a PM
pings when there is news for the people watching but not working the program. Its
resolver docstring left a deferred slice open: "the AC's *+ external stakeholder
list* has no backing model yet." Issue #1658 is that slice.

The real-world need: many program stakeholders — a client's VP sponsor, a vendor's
account lead, an external auditor — have **no TruePPM account** and never will, yet a
PM wants them included when they type `@program-stakeholders`. Today those people are
invisible to the mention system.

**P3M layer / boundary.** A stakeholder registry scoped to one program, managed by
that program's PM, is squarely OSS (CLAUDE.md two-repo rule: a program is one
PM/team's set of related projects). This is *not* an org-level contact directory,
CRM, or cross-program governance surface — those would be Enterprise. Nothing here
imports from `trueppm_enterprise`.

**Why the outbound-email half is deferred to #1675.** The original #1658 scope
imagined a single "notify the stakeholders" action that would *email* every external
address (and, in one variant, blind-copy them onto the same alias as internal
recipients). A Voice-of-Customer pass scored that delivery design **3.25/10** with
three red blockers:

1. **Deliverability / spam.** A self-hosted TruePPM instance sending unsolicited mail
   to external client/vendor addresses, from whatever SMTP the operator configured,
   is a near-certain spam-folder (or blocklist) outcome — and a support burden the
   registry itself does not incur.
2. **Internal-leak-to-clients via the union.** Unioning external addresses into the
   same fan-out as internal Viewer members risks a comment body — or a reply-all —
   reaching a client that was only ever meant for the internal view-only audience.
   The mention system already has a cross-project email read-boundary (ADR-0248 §5);
   external recipients need an even stricter one, plus its own consent model.
3. **No audit / consent trail.** Emailing an external party is a compliance-relevant
   act (who added them, did they consent, can they unsubscribe). None of that exists
   yet, and bolting it onto a first cut would be worse than shipping nothing.

The registry (the *who*) is independently valuable and carries none of those risks.
So #1658 ships **the model + resolver only**; #1675 owns the delivery design
(deliverability, a stakeholder-only fan-out that never unions with internal
recipients, and a consent/audit trail).

## Decision

### 1. Model — `access.ExternalStakeholder` (plain `models.Model`, NOT VersionedModel)
Placed next to `ProgramUserDefinedMentionGroup` in `access/models.py` for cohesion
(the FK to `projects.Program` is cross-app, as the mention-group model's already is).

- `id` `UUIDField` pk (`default=uuid4`).
- `program` FK → `projects.Program` (`CASCADE`, `related_name="external_stakeholders"`).
- `name` `CharField(max_length=200)`, `email` `EmailField`, `note` `TextField(blank, default="")`.
- `created_by` FK → user (`SET_NULL`, `related_name="+"`); `created_at` / `updated_at`.
- `is_deleted` `BooleanField` — soft-delete.
- Meta: case-insensitive `(program, Lower(email))` `UniqueConstraint` **conditioned on
  `is_deleted=False`** (a soft-deleted row frees its email for re-add, mirroring the
  mention-group constraint), plus an index on `(program, is_deleted)`.

**Registry/config, not sync state.** Like `ShareLink` and `ApiToken`, this is a plain
`models.Model` with **no `server_version`**. External stakeholders are a server-side
program *setting*, never a board object a mobile client edits offline, so they are
deliberately excluded from the WatermelonDB delta. Resolution is server-side at
comment-write time; offline clients never need the rows.

### 2. Resolver — additive and SEPARATE, never unioned
`resolve_external_stakeholders(project_id)` resolves the project's program
(`Project.program`) and returns that program's non-deleted rows (snapshot semantics,
matching every other mention resolver). Returns `[]` for a standalone project.

The key decision: external stakeholders are **additive and kept separate**, never
merged into the User-keyed `@program-stakeholders` result. `MentionParseResult` gains
a distinct `external_targets: list[ExternalStakeholder]` field; the existing
Viewer-member resolution (`resolve_group_members`) is **unchanged**. Because these
rows have no `User`, unioning them into `group_targets` would be a type lie and, worse,
the seed of the internal-leak blocker above. Keeping them on their own field means the
delivery work in #1675 can apply a stakeholder-specific policy without touching the
internal path.

`resolve_parsed_mentions` populates `external_targets` **only** when
`@program-stakeholders` actually resolved (it is present in `group_targets` — a
standalone project skips it), so a hand-typed key on a project with no program
resolves to nothing on both arms.

### 3. Management API — program-scoped CRUD, Admin+ only
`GET/POST /api/v1/programs/{program_pk}/external-stakeholders/` and
`GET/PATCH/DELETE …/{id}/`, a `ModelViewSet` (plain-array list, no pagination
envelope — matching the sibling program-group hook).

- **RBAC:** program **Admin+** (`IsProgramAdmin`, the existing `Role.ADMIN` threshold —
  reused verbatim, not reinvented) for **every** action, list included. Managing who is
  externally pinged is an administrative act; Scheduler/Member/Viewer/non-member get
  403. `IsProgramNotClosed` blocks writes to a closed program while still allowing reads.
- **IDOR-safe:** the queryset is scoped to the URL's `program_pk` (and live rows); the
  body's program is never trusted. `created_by` is stamped from `request.user`; `program`
  from the URL.
- Create enforces the CI-unique email with a friendly 400 (serializer check ahead of the
  DB constraint backstop). `DELETE` is a soft-delete (`is_deleted=True`).

### 4. No outbound email; count surfaced informationally
No email is sent and no `Notification`/`Mention` rows are created for external targets
(they have no recipient `User`). The comment-create path surfaces
`external_recipient_count = len(external_targets)` on the `task_comment_created`
real-time event so a client can note "N external stakeholders would be emailed" — purely
informational until #1675 wires delivery. A settings flag was considered and **omitted**:
a `TRUEPPM_EXTERNAL_STAKEHOLDER_EMAIL_ENABLED` toggle that gates nothing shipped would be
a defined-but-unused setting (and a dead code branch). #1675 introduces it alongside the
code it actually guards.

### 5. Web — program settings sub-page
An "External stakeholders" section in program settings (`ProgramSettingsPage`, the
one-scroll shell per ADR-0146), with its own nav item and `settings/stakeholders`
sub-slug redirect. Admin+ sees add (name + email + optional note) and remove; the
subtitle makes clear these are non-account people included in `@program-stakeholders`
pings and that **email delivery will be added in a future release** — future tense, since
delivery is unshipped.

## Consequences
- The *who* ships now and is immediately useful (the registry is visible and curatable);
  the *notify* ships in #1675 without re-litigating the data model.
- `MentionParseResult` grows one field with a safe empty default; all existing producers
  and consumers are unaffected (external stakeholders never enter the notification fan-out).
- A future org-level / cross-program contact directory remains an Enterprise concern; this
  registry is deliberately program-scoped and does not generalize toward it.

## References
- Issue #1658 (this ADR); follow-up #1675 (outbound delivery).
- ADR-0075 / ADR-0240 (`@program-stakeholders` auto-group), ADR-0248 (program-scoped
  user-defined groups — mirrored patterns), ADR-0146 (one-scroll settings shell).
