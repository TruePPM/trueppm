/**
 * The drift ledger: every operation whose e2e mocks still disagree with
 * `docs/api/openapi.json`, and the reason each one is still served (#3440).
 *
 * Read this as a ledger, not as an exemption list. Each entry is one place a
 * spec is still asserting the front end against itself; `schema-guard.ts` fails
 * the spec on every operation NOT listed here — 237 of the 339 the mock layer
 * touches, plus everything a future spec mocks.
 *
 * Be honest about what a waiver buys. Like `--update-baseline` on the docs gate,
 * it cannot stop a wrong answer — a wrong entry here gets today's outcome. What
 * it removes is the **silence**: before this file existed, a mock the server
 * could never produce generated no signal anywhere in the pipeline. The first
 * measured pass found 346 such lines across 104 operations, all of them green;
 * #3440 corrected four field families, and these 100 operations are what is
 * left. (#3649 closed the cluster-(a) list-vs-envelope entries below — that
 * wildcard was also silently covering two `/members/` operations' unrelated
 * #2633 user-id drift, which needed its own narrower cluster-(e) entry once
 * uncovered.)
 *
 * ## Shape
 *
 *   'GET /api/v1/thing/': {
 *     reason: 'why, and the issue that removes it',
 *     allow: ['results[].field:type', '<root>:unknown-property'],
 *   }
 *
 * · The key is `METHOD /api/v1/path/{template}/` exactly as the schema spells
 *   it — that is what the guard resolves a request URL to.
 * · Each `allow` entry is `<property path>:<rule>`, and waives only that pair.
 *   Array indices collapse to `[]`, so one line covers every row of a list. The
 *   guard prints the exact line to add when it fails, so an entry is never
 *   guesswork.
 * · `'*'` waives the whole operation. Every entry seeded by #3440 uses it, and
 *   that is a deliberate trade, not laziness: the property-level form is
 *   strictly tighter, but it is only as complete as the run that measured it.
 *   Several of these responses are reached on a race-dependent path and appeared
 *   in one of the two full suite passes and not the other, so a property-level
 *   ledger built from either would red a spec nobody touched, nondeterministically,
 *   on a loaded runner — the exact failure shape this tree spends the most time
 *   chasing. `'*'` costs enforcement on the other properties of these 100
 *   operations and buys a ledger that does not flake. Use the property-level
 *   form for anything added from here, where you know the one line you mean.
 * · Every reason names the issue that removes it. A waiver with no issue is a
 *   bug waiting to be re-found, and `scripts/check-e2e-schema-guard.sh` rejects
 *   one. That script also ratchets the entry count: it may shrink — and when it
 *   does, the budget must be lowered in the same MR — never grow.
 *
 * ## The six clusters, and which side is wrong
 *
 * Each was verified against the Django source before it was written down; the
 * cluster says which artifact to change, which is the part a bare "mismatch"
 * cannot tell you.
 *
 * **(a) SCHEMA WRONG — a hand-written `list()` returns a bare array** (#3649).
 * drf-spectacular infers a paginated envelope from the `GenericViewSet` default
 * pagination class even where `list()` is overridden and returns
 * `Response(serializer.data)` on a plain list. The mock and the client both match
 * the *server*; only the published contract is wrong, so "fixing" the mock would
 * make it wrong.
 *
 * **(b) SCHEMA WRONG — an under-declared response** (#3650). `GET /me/work/`
 * hand-adds five real top-level keys the declared schema does not model.
 *
 * **(c) SCHEMA WRONG — nullability** (#3651). Fields that are genuinely null at
 * runtime whose serializer declares no `allow_null`, so the published schema
 * types them non-nullable. This is the shape that crashes a *correctly written*
 * generated client.
 *
 * **(d) SPEC CATCH-ALL** (#3653). Fourteen specs register their own
 * `**\/api/v1/**` returning `[]` or a `{count,next,previous,results}` envelope
 * for *everything*, so an object-shaped endpoint is answered with a list. That is
 * the crash class CLAUDE.md describes — the component throws, the root error
 * boundary replaces the app, and it surfaces as a flaky detached-element timeout
 * on an unrelated click. Converting them is per-spec work.
 *
 * **(e) #2633 — user ids are integers.** `created_by`, `lead` and
 * `lead_detail.id` are `AutoField` integer PKs; `types.ts` types them `string`
 * and every fixture follows. Correcting it is 30 TypeScript errors across ~12
 * files — the other half of #2633, outside the denominator #3440 bound. Listed
 * rather than silently tolerated: these entries are the proof the drift is live,
 * and #2633 closing is what deletes them.
 *
 * **(f) MOCK WRONG — stale or invented fields** (#3654). Fields no serializer
 * sends (`assignees` for `assignments`, `is_critical` for `is_driving`,
 * `finish_date`, `skill_fit`) and enum values the server cannot emit. Four
 * families were fixed in #3440 itself; the rest are ~10 investigations, each of
 * which may surface a component reading a field that does not exist.
 */
export interface SchemaGuardWaiver {
  /** Why this drift is still served, and the issue whose closure removes it. */
  reason: string;
  /**
   * `<property path>:<rule>` pairs this waiver covers — nothing else is waived.
   * `'*'` waives the whole operation; see the file header for when that is the
   * right call and when it is not.
   */
  allow: string[];
}

export const SCHEMA_GUARD_WAIVERS: Readonly<Record<string, SchemaGuardWaiver>> = {
  // ---------------------------------------------------------------------------
  // (a) SCHEMA WRONG - a hand-written list() returns a bare array - 0 operations
  // Fixed in #3649: the five list() overrides now carry @extend_schema(responses=
  // {200: <Serializer>(many=True)}) + @suppress_list_pagination, so the published
  // schema matches the bare array each already returned.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // (b) SCHEMA WRONG - the schema under-declares a hand-built response - 1 operations
  // ---------------------------------------------------------------------------
  'GET /api/v1/me/work/': {
    reason:
      'SCHEMA-WRONG (#3650): MeWorkView.list() hand-adds five top-level keys that the declared ' +
      'PaginatedMeWorkTaskList does not model. The extra keys the mock sends are real server fields. ' +
      'Observed: due_today_count:unknown-property, active_sprints:unknown-property, ' +
      'server_version_high_water:unknown-property, <root>:type, retro_action_items:unknown-property, ' +
      '+5 more.',
    allow: ['*'],
  },
  // ---------------------------------------------------------------------------
  // (c) SCHEMA WRONG - a genuinely nullable field is declared non-nullable - 12 operations
  // ---------------------------------------------------------------------------
  'GET /api/v1/projects/trash/': {
    reason:
      'SCHEMA-WRONG (#3651): the field is genuinely null at runtime, but the serializer declares no ' +
      'allow_null, so drf-spectacular published it as non-nullable. Observed: ' +
      '[].code:null-on-non-nullable.',
    allow: ['*'],
  },
  'GET /api/v1/projects/{project_pk}/tasks/{task_pk}/attachments/': {
    reason:
      'SCHEMA-WRONG (#3651): the field is genuinely null at runtime, but the serializer declares no ' +
      'allow_null, so drf-spectacular published it as non-nullable. Observed: ' +
      'results[].deleted_by:null-on-non-nullable.',
    allow: ['*'],
  },
  'GET /api/v1/projects/{project_pk}/tasks/{task_pk}/comments/': {
    reason:
      'SCHEMA-WRONG (#3651): the field is genuinely null at runtime, but the serializer declares no ' +
      'allow_null, so drf-spectacular published it as non-nullable. Observed: ' +
      'results[].deleted_by:null-on-non-nullable.',
    allow: ['*'],
  },
  'GET /api/v1/projects/{project_pk}/tasks/{task_pk}/notes/': {
    reason:
      'SCHEMA-WRONG (#3651): the field is genuinely null at runtime, but the serializer declares no ' +
      'allow_null, so drf-spectacular published it as non-nullable. Observed: ' +
      'results[].deleted_by:null-on-non-nullable.',
    allow: ['*'],
  },
  'GET /api/v1/sprints/{sprint_pk}/poker/': {
    reason:
      'SCHEMA-WRONG (#3651): the field is genuinely null at runtime, but the serializer declares no ' +
      'allow_null, so drf-spectacular published it as non-nullable. Observed: ' +
      '[].started_by:null-on-non-nullable.',
    allow: ['*'],
  },
  'PATCH /api/v1/projects/{project_pk}/tasks/{task_pk}/comments/{id}/': {
    reason:
      'SCHEMA-WRONG (#3651): the field is genuinely null at runtime, but the serializer declares no ' +
      'allow_null, so drf-spectacular published it as non-nullable. Observed: ' +
      'deleted_by:null-on-non-nullable.',
    allow: ['*'],
  },
  'POST /api/v1/poker/{id}/commit/': {
    reason:
      'SCHEMA-WRONG (#3651): the field is genuinely null at runtime, but the serializer declares no ' +
      'allow_null, so drf-spectacular published it as non-nullable. Observed: ' +
      'started_by:null-on-non-nullable.',
    allow: ['*'],
  },
  'POST /api/v1/poker/{id}/reveal/': {
    reason:
      'SCHEMA-WRONG (#3651): the field is genuinely null at runtime, but the serializer declares no ' +
      'allow_null, so drf-spectacular published it as non-nullable. Observed: ' +
      'started_by:null-on-non-nullable.',
    allow: ['*'],
  },
  'POST /api/v1/poker/{id}/vote/': {
    reason:
      'SCHEMA-WRONG (#3651): the field is genuinely null at runtime, but the serializer declares no ' +
      'allow_null, so drf-spectacular published it as non-nullable. Observed: ' +
      'started_by:null-on-non-nullable.',
    allow: ['*'],
  },
  'POST /api/v1/projects/{project_pk}/tasks/{task_pk}/attachments/': {
    reason:
      'SCHEMA-WRONG (#3651): the field is genuinely null at runtime, but the serializer declares no ' +
      'allow_null, so drf-spectacular published it as non-nullable. Observed: ' +
      'deleted_by:null-on-non-nullable.',
    allow: ['*'],
  },
  'POST /api/v1/projects/{project_pk}/tasks/{task_pk}/comments/': {
    reason:
      'SCHEMA-WRONG (#3651): the field is genuinely null at runtime, but the serializer declares no ' +
      'allow_null, so drf-spectacular published it as non-nullable. Observed: ' +
      'deleted_by:null-on-non-nullable.',
    allow: ['*'],
  },
  'POST /api/v1/projects/{project_pk}/tasks/{task_pk}/notes/': {
    reason:
      'SCHEMA-WRONG (#3651): the field is genuinely null at runtime, but the serializer declares no ' +
      'allow_null, so drf-spectacular published it as non-nullable. Observed: ' +
      'deleted_by:null-on-non-nullable.',
    allow: ['*'],
  },
  // ---------------------------------------------------------------------------
  // (d) SPEC CATCH-ALL - one shape answers every endpoint - 27 operations
  // ---------------------------------------------------------------------------
  'GET /api/v1/auth/me/pinned/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/calendars/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type, results[].working_days:type.',
    allow: ['*'],
  },
  'GET /api/v1/dependencies/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      'results[].is_critical:unknown-property, results[].dependency_type:unknown-property, ' +
      'results[].project:unknown-property, <root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/health/system/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/me/external-items/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/me/notifications/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type, results[].mention:null-on-non-nullable, results[].snippet:null-on-non-nullable, ' +
      'results[].recipient:type, results[].mention.scope:enum.',
    allow: ['*'],
  },
  'GET /api/v1/programs/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      'results[].created_by:type, <root>:type, results[].lead:type, results[].lead_detail.id:type.',
    allow: ['*'],
  },
  'GET /api/v1/programs/{id}/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      'created_by:type, lead:type, lead_detail.id:type, count:unknown-property, ' +
      'next:unknown-property, +2 more.',
    allow: ['*'],
  },
  'GET /api/v1/programs/{id}/mention-reach/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/programs/{id}/risk-policy/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/programs/{id}/rollup-config/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/programs/{program_pk}/api-tokens/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/programs/{program_pk}/backlog-items/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/programs/{program_pk}/ceremonies/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/programs/{program_pk}/webhooks/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/projects/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      'results[].program_detail:unknown-property, <root>:type, ' +
      'results[].recalculated_at:unknown-property, results[].is_sample:unknown-property, ' +
      'results[].finish_date:unknown-property, +2 more.',
    allow: ['*'],
  },
  'GET /api/v1/projects/health-summary/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/projects/{id}/presence/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed on an ' +
      'earlier pass of this suite; this operation was not exercised in the run that measured the ' +
      'ledger, so it is kept rather than dropped on one sample.',
    allow: ['*'],
  },
  'GET /api/v1/projects/{id}/status-summary/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed on an ' +
      'earlier pass of this suite; this operation was not exercised in the run that measured the ' +
      'ledger, so it is kept rather than dropped on one sample.',
    allow: ['*'],
  },
  'GET /api/v1/sprints/{id}/close-request/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/sprints/{id}/daily-delta/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/sprints/{id}/outcome/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/velocity-suggestions/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type.',
    allow: ['*'],
  },
  'GET /api/v1/workspace/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      '<root>:type, id:unknown-property, count:unknown-property, next:unknown-property, ' +
      'previous:unknown-property, +5 more.',
    allow: ['*'],
  },
  'PATCH /api/v1/tasks/{id}/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      'assignees:unknown-property, wbs_path:null-on-non-nullable, project_id:unknown-property, ' +
      'project_name:unknown-property, program_id:unknown-property, +16 more.',
    allow: ['*'],
  },
  'POST /api/v1/projects/{id}/visit/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      'count:unknown-property, next:unknown-property, previous:unknown-property, ' +
      'results:unknown-property, ok:unknown-property, +1 more.',
    allow: ['*'],
  },
  'POST /api/v1/ws/ticket/': {
    reason:
      'SPEC CATCH-ALL (#3653): a spec registers its own **/api/v1/** route that answers every ' +
      'endpoint with one shape, so an object endpoint is served a list or a paginated envelope. This ' +
      'is the crash class CLAUDE.md documents; converting each spec is per-spec work. Observed: ' +
      'count:unknown-property, next:unknown-property, previous:unknown-property, ' +
      'results:unknown-property, <root>:type.',
    allow: ['*'],
  },
  // ---------------------------------------------------------------------------
  // (e) #2633 - user ids are integers server-side, strings in types.ts - 14 operations
  // ---------------------------------------------------------------------------
  'GET /api/v1/projects/{id}/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side and typed string in types.ts, so every ' +
      'fixture follows. Correcting it is 30 TypeScript errors across ~12 files, which is the other ' +
      'half of #2633 and outside the denominator #3440 bound. Observed: finish_date:unknown-property, ' +
      'lead:type, lead_detail.id:type.',
    allow: ['*'],
  },
  'PATCH /api/v1/programs/{id}/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side and typed string in types.ts, so every ' +
      'fixture follows. Correcting it is 30 TypeScript errors across ~12 files, which is the other ' +
      'half of #2633 and outside the denominator #3440 bound. Observed: created_by:type, lead:type, ' +
      'lead_detail.id:type.',
    allow: ['*'],
  },
  'PATCH /api/v1/programs/{program_pk}/backlog-items/{id}/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side and typed string in types.ts, so every ' +
      'fixture follows. Correcting it is 30 TypeScript errors across ~12 files, which is the other ' +
      'half of #2633 and outside the denominator #3440 bound. Observed: created_by:type.',
    allow: ['*'],
  },
  'PATCH /api/v1/programs/{program_pk}/ceremonies/{id}/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side and typed string in types.ts, so every ' +
      'fixture follows. Correcting it is 30 TypeScript errors across ~12 files, which is the other ' +
      'half of #2633 and outside the denominator #3440 bound. Observed: created_by:type.',
    allow: ['*'],
  },
  'PATCH /api/v1/projects/{id}/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side and typed string in types.ts, so every ' +
      'fixture follows. Correcting it is 30 TypeScript errors across ~12 files, which is the other ' +
      'half of #2633 and outside the denominator #3440 bound. Observed: ' +
      'program_detail:unknown-property, lead:type, lead_detail.id:type.',
    allow: ['*'],
  },
  'POST /api/v1/programs/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side and typed string in types.ts, so every ' +
      'fixture follows. Correcting it is 30 TypeScript errors across ~12 files, which is the other ' +
      'half of #2633 and outside the denominator #3440 bound. Observed: created_by:type.',
    allow: ['*'],
  },
  'POST /api/v1/programs/{id}/close/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side and typed string in types.ts, so every ' +
      'fixture follows. Correcting it is 30 TypeScript errors across ~12 files, which is the other ' +
      'half of #2633 and outside the denominator #3440 bound. Observed: created_by:type, ' +
      'closed_by:type.',
    allow: ['*'],
  },
  'POST /api/v1/programs/{id}/transfer-sponsorship/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side and typed string in types.ts, so every ' +
      'fixture follows. Correcting it is 30 TypeScript errors across ~12 files, which is the other ' +
      'half of #2633 and outside the denominator #3440 bound. Observed: created_by:type.',
    allow: ['*'],
  },
  'POST /api/v1/programs/{program_pk}/backlog-items/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side and typed string in types.ts, so every ' +
      'fixture follows. Correcting it is 30 TypeScript errors across ~12 files, which is the other ' +
      'half of #2633 and outside the denominator #3440 bound. Observed: created_by:type.',
    allow: ['*'],
  },
  'POST /api/v1/programs/{program_pk}/ceremonies/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side and typed string in types.ts, so every ' +
      'fixture follows. Correcting it is 30 TypeScript errors across ~12 files, which is the other ' +
      'half of #2633 and outside the denominator #3440 bound. Observed: created_by:type.',
    allow: ['*'],
  },
  'POST /api/v1/task-relations/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side and typed string in types.ts, so every ' +
      'fixture follows. Correcting it is 30 TypeScript errors across ~12 files, which is the other ' +
      'half of #2633 and outside the denominator #3440 bound. Observed: created_by:type.',
    allow: ['*'],
  },
  // #3649 narrowed the cluster-(a) wildcard on these two `/members/` operations to
  // just its pagination-envelope claim, which surfaced this pre-existing #2633
  // drift underneath it — it was never fixed, only hidden by the broader waiver.
  'GET /api/v1/projects/{project_pk}/members/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side and typed string in types.ts, so every ' +
      'fixture follows. Correcting it is 30 TypeScript errors across ~12 files, which is the other ' +
      'half of #2633 and outside the denominator #3440 bound. Observed: [].user:type, ' +
      '[].user_detail.id:type.',
    allow: ['*'],
  },
  'GET /api/v1/programs/{program_pk}/members/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side and typed string in types.ts, so every ' +
      'fixture follows. Correcting it is 30 TypeScript errors across ~12 files, which is the other ' +
      'half of #2633 and outside the denominator #3440 bound. Observed: [].user:type, ' +
      '[].user_detail.id:type.',
    allow: ['*'],
  },
  'GET /api/v1/projects/{project_pk}/mention-groups/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side and typed string in types.ts, so every ' +
      'fixture follows. Correcting it is 30 TypeScript errors across ~12 files, which is the other ' +
      'half of #2633 and outside the denominator #3440 bound. Observed: [].members[].id:type.',
    allow: ['*'],
  },
  // ---------------------------------------------------------------------------
  // (f) MOCK WRONG - stale or invented fields, and enums the server cannot emit - 46 operations
  // ---------------------------------------------------------------------------
  'GET /api/v1/agent-actions/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: results[].refusal_detail:null-on-non-nullable, ' +
      'results[].refusal_reason:enum, results[].principal:type, results[].refusal_detail:type.',
    allow: ['*'],
  },
  'GET /api/v1/programs/{id}/projects/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: [].description:unknown-property.',
    allow: ['*'],
  },
  'GET /api/v1/programs/{program_pk}/label-tasks/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: withheld_project_count:unknown-property.',
    allow: ['*'],
  },
  'GET /api/v1/projects/{id}/sprint-forecast/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: status:enum.',
    allow: ['*'],
  },
  'GET /api/v1/projects/{project_pk}/labels/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: results[].color:enum.',
    allow: ['*'],
  },
  'GET /api/v1/projects/{project_pk}/risks/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: results[].owner:type.',
    allow: ['*'],
  },
  'GET /api/v1/projects/{project_pk}/sprints/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: results[].state:enum.',
    allow: ['*'],
  },
  'GET /api/v1/projects/{project_pk}/tasks/{task_pk}/links/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: [].preview_type:enum.',
    allow: ['*'],
  },
  'GET /api/v1/projects/{project_pk}/webhooks/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: results[].events[]:enum.',
    allow: ['*'],
  },
  'GET /api/v1/resources/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: results[].skill_fit:unknown-property, ' +
      'results[].missing_skills:unknown-property, results[].is_deleted:unknown-property.',
    allow: ['*'],
  },
  'GET /api/v1/resources/{id}/assignments/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: results[].server_version:unknown-property, ' +
      'results[].name:unknown-property, results[].email:unknown-property, ' +
      'results[].job_role:unknown-property, results[].max_units:unknown-property, +2 more.',
    allow: ['*'],
  },
  'GET /api/v1/task-relations/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: [].created_by:type.',
    allow: ['*'],
  },
  'GET /api/v1/task-resources/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: results[].units:type.',
    allow: ['*'],
  },
  'GET /api/v1/tasks/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: results[].assignees:unknown-property, ' +
      'results[].assignments[].units:type, results[].assignments[].id:unknown-property, ' +
      'results[].labels[].server_version:unknown-property, results[].owners:unknown-property, +3 ' +
      'more.',
    allow: ['*'],
  },
  'GET /api/v1/teams/{team_pk}/members/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: results[].user:type, results[].user_detail.id:type.',
    allow: ['*'],
  },
  'GET /api/v1/users/search/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: [].email:unknown-property.',
    allow: ['*'],
  },
  'PATCH /api/v1/dependencies/{id}/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: is_critical:unknown-property.',
    allow: ['*'],
  },
  'PATCH /api/v1/me/notifications/{id}/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: recipient:type, mention.scope:enum, ' +
      'mention:null-on-non-nullable.',
    allow: ['*'],
  },
  'PATCH /api/v1/projects/{id}/tasks/classification/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: capabilities_denied:unknown-property.',
    allow: ['*'],
  },
  'PATCH /api/v1/projects/{project_pk}/members/{id}/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: id:unknown-property, ' +
      'server_version:unknown-property, project:unknown-property, user:type, ' +
      'user_detail:unknown-property, +5 more.',
    allow: ['*'],
  },
  'PATCH /api/v1/projects/{project_pk}/webhooks/{id}/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: events[]:enum.',
    allow: ['*'],
  },
  'PATCH /api/v1/teams/{team_pk}/members/{id}/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: id:unknown-property, user:unknown-property, ' +
      'user_detail:unknown-property, role_label:unknown-property.',
    allow: ['*'],
  },
  'POST /api/v1/admin/failed-tasks/{id}/requeue/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: workflow_id:unknown-property.',
    allow: ['*'],
  },
  'POST /api/v1/auth/token/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: refresh:unknown-property.',
    allow: ['*'],
  },
  'POST /api/v1/me/api-tokens/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: token:unknown-property.',
    allow: ['*'],
  },
  'POST /api/v1/me/notifications/{id}/snooze/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: recipient:type, mention.scope:enum.',
    allow: ['*'],
  },
  'POST /api/v1/programs/load-sample/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: program.created_by:type.',
    allow: ['*'],
  },
  'POST /api/v1/programs/{program_pk}/api-tokens/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: token:unknown-property.',
    allow: ['*'],
  },
  'POST /api/v1/programs/{program_pk}/members/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: id:unknown-property, ' +
      'server_version:unknown-property, program:unknown-property, user:type, ' +
      'user_detail:unknown-property, +1 more.',
    allow: ['*'],
  },
  'POST /api/v1/programs/{program_pk}/mention-groups/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: id:unknown-property, ' +
      'server_version:unknown-property, program:unknown-property, members:unknown-property, ' +
      'member_count:unknown-property, +1 more.',
    allow: ['*'],
  },
  'POST /api/v1/projects/{id}/archive/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: archived_by:type.',
    allow: ['*'],
  },
  'POST /api/v1/projects/{id}/tasks/{task_id}/reparent/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: updated:type.',
    allow: ['*'],
  },
  'POST /api/v1/projects/{project_pk}/api-tokens/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: token:unknown-property.',
    allow: ['*'],
  },
  'POST /api/v1/projects/{project_pk}/members/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: id:unknown-property, ' +
      'server_version:unknown-property, project:unknown-property, user:type, ' +
      'user_detail:unknown-property, +3 more.',
    allow: ['*'],
  },
  'POST /api/v1/projects/{project_pk}/mention-groups/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: id:unknown-property, ' +
      'server_version:unknown-property, project:unknown-property, members:unknown-property, ' +
      'member_count:unknown-property, +1 more.',
    allow: ['*'],
  },
  'POST /api/v1/projects/{project_pk}/tasks/{task_pk}/links/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: preview_type:enum.',
    allow: ['*'],
  },
  'POST /api/v1/projects/{project_pk}/tasks/{task_pk}/links/{id}/refresh/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: preview_type:enum.',
    allow: ['*'],
  },
  'POST /api/v1/resources/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: is_deleted:unknown-property.',
    allow: ['*'],
  },
  'POST /api/v1/resources/{id}/restore/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: is_deleted:unknown-property.',
    allow: ['*'],
  },
  'POST /api/v1/sprints/{id}/activate/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: warnings:unknown-property.',
    allow: ['*'],
  },
  'POST /api/v1/task-resources/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: units:type, warnings:unknown-property.',
    allow: ['*'],
  },
  'POST /api/v1/tasks/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: assignees:unknown-property, ' +
      'wbs_path:null-on-non-nullable, parent:unknown-property.',
    allow: ['*'],
  },
  'POST /api/v1/tasks/{id}/restore/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: assignees:unknown-property.',
    allow: ['*'],
  },
  'POST /api/v1/tasks/{task_pk}/time-entries/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: task_short_id:unknown-property, ' +
      'task_name:unknown-property, project:unknown-property, project_code:unknown-property, ' +
      'project_name:unknown-property.',
    allow: ['*'],
  },
  'POST /api/v1/velocity-suggestions/{id}/accept/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: accepted_by:type.',
    allow: ['*'],
  },
  'POST /api/v1/velocity-suggestions/{id}/dismiss/': {
    reason:
      'MOCK-WRONG (#3654): the fixture sends a field or an enum value that no serializer produces. ' +
      'The sweep is ~10 separate investigations, each of which may surface a component reading a ' +
      'field the server does not send. Observed: dismissed_by:type.',
    allow: ['*'],
  },
};
