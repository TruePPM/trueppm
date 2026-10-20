# ADR-1291: Published enums are open by default

## Status
Accepted (2026-10-19). Amends [ADR-0072](0072-role-ordinals-extension-point.md)
§ *Public API surface* (see its Amendment 2). Implemented in #4593.

## Context

The [API stability policy](../../packages/website/src/content/docs/api/stability.md)
classes "a new enum value on a non-exhaustive field" as **Additive** and tells
clients to tolerate one. The published schema contradicted it: every one of the
143 enum components in `docs/api/openapi.json` was a plain JSON Schema `enum`,
which is closed by definition, and nothing marked any field non-exhaustive. So:

- a strict generated client (a Java, Kotlin, Swift or Go decoder built from the
  schema) rejects exactly the change the policy promised was safe;
- our own e2e schema guard (#3440) fails any mock carrying a value outside the
  list, so a spec could not test the tolerance the policy demands;
- `RoleEnum = [1, 100, 200, 300, 400]` was closed over the ordinal bands ADR-0072
  reserves for Enterprise custom roles. An Enterprise install returning a role at
  `250` breaks the published OSS contract by design.

The "non-exhaustive" qualifier in `stability.md` had no referent. Either every
enum is closed (and a new value is Breaking) or the schema has to say which are
open.

## Decision

### 1. Open by default, with a short exhaustive allowlist

Every enum may grow unless it is named as exhaustive. Adding a value to an open
enum is **Additive**; adding one to an exhaustive enum is **Breaking**. On a
request field, "open" means a later release may *accept* more values; the server
in front of you accepts exactly the listed ones and answers `400` to anything
else.

The exhaustive set is `EXHAUSTIVE_ENUMS` in `packages/api/src/trueppm_api/core/openapi.py`,
each entry with its reason:

| Component | Why it is closed |
|---|---|
| `BlankEnum`, `NullEnum` | drf-spectacular's structural branches for a blankable / nullable choice field. Not vocabularies; opening them would make every `oneOf` they sit in accept anything. |
| `DepTypeEnum` | FS / SS / FF / SF is the complete set of precedence relationships, and both scheduling engines hard-code four. A fifth is a new engine contract. |
| `DigestWeekdayEnum` | The seven weekdays. |
| `ProjectBurnCombinedChartTypeEnum`, `ProjectBurnSeriesChartTypeEnum`, `ScheduleCpmDerivationPassEnum`, `ScheduleMonteCarloDerivationPassEnum` | Discriminator tags of a `oneOf` response. A client dispatches on them; a new chart type or engine pass arrives as a new variant, not as a new value of an existing variant's tag. |

Inline enums (query parameters, anonymous properties) follow the same default,
except a boolean or null constant (`"sent": [false]`), which has no room to grow.

### 2. The marker: `x-trueppm-enum: "open" | "exhaustive"`, beside `enum`

A drf-spectacular post-processing hook (`_mark_enum_openness`) stamps every enum
node in the document. It **keeps `enum`** and adds the marker beside it.

The alternative was to *replace* `enum`, as Zalando's `x-extensible-enum`
convention does. That is the only form under which a schema-validating client
structurally cannot reject a new value. We rejected it because the cost lands on
everyone and the benefit lands on almost no one:

- Removing `enum` strips the known values from every typed client. `openapi-typescript`
  and Orval would emit `string` where they emit a literal union today, and the
  reference docs would stop listing the values.
- No mainstream generator reads `x-extensible-enum` either. Most generators that
  produce a rejecting decoder have their own switch for an unknown-value case,
  such as openapi-generator's `enumUnknownDefaultCase`. A client still has to
  configure something. The marker tells it which fields that applies to.
- Replacing `enum` on 143 components would make the diff against the last
  published schema remove every enum. A breaking-change gate (#4594) would read
  that as 143 breaks. Adding a key is additive.

Azure's `x-ms-enum: {modelAsString: true}` is the precedent for this shape. It is
an openness flag beside a kept `enum`. We use our own namespaced key, not
`x-extensible-enum`, because that name already means "an array of values that
replaces `enum`". A tool that knows the convention would misread a string flag
under it.

### 3. Role ordinals are a banded integer, not an enum

The hook replaces the `RoleEnum` component with `RoleOrdinal` and repoints every
reference to it. That covers `role` on project and program memberships and
`default_member_role` on projects. It also points the project-role fields that
were bare `integer`s at the same component: `my_role` wherever it appears, the
membership write `role`, the workspace-group project grant `role`, and
`max_project_role` on `/auth/me/` (`_BARE_ROLE_FIELDS`). Workspace-role fields
are a separate `WorkspaceRole` scale and are left as they are. `RoleOrdinal` is
`{type: integer, minimum: 1, maximum: 400}`. Its description is derived from the
`Role` choices, names the five OSS ordinals and the four reserved bands, and
tells a client to compare with `>=` against a band floor. This is the contract
ADR-0072 already states for server code. The OSS server still accepts only the
five OSS ordinals on write. Whether the database enforces that is #4583, which
this change does not touch.

### 4. The e2e schema guard honors the marker

A value outside an **exhaustive** enum still fails a spec under the `enum` rule.
A new value on an **open** enum is measured as `open-enum-value` but does not
fail, just as `missing-required` is measured without failing. A value that folds
(case, `-`, `_`) onto a declared one is a typo, not a future value, so it still
fails under `enum`. That keeps the #3440 `'OPEN'`-for-`'open'` class red. The
`oneOf` branch matcher ignores `open-enum-value`. Without that, a nullable choice
field would close every open enum again.

## Consequences

- **Breaking, once:** the `RoleEnum` component is removed, so an SDK generated
  from the schema loses that model class. `role` fields widen from a closed set to
  a range. The break is recorded in `stability.md` under *Current deprecations*.
  It is pre-GA and ships without a window.
- `stability.md` now has a referent for "non-exhaustive": the marker.
- A new choice field is open with no action. Making one exhaustive means adding
  an `EXHAUSTIVE_ENUMS` entry with a reason. `test_openapi_enum_openness.py`
  fails if the closed set in the published schema and the allowlist disagree.
- Weaker guard coverage, accepted on purpose: a mock that invents a plausible but
  wrong value on an open enum (one that is not a near-miss) no longer fails a
  spec. It shows up in the `open-enum-value` count in the observation report.
