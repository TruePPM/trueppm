/**
 * The drift ledger: every operation whose e2e mocks still disagree with
 * `docs/api/openapi.json`, and the reason each one is still served (#3440).
 *
 * Read this as a ledger, not as an exemption list. Each entry is one place a
 * mock and the published schema still disagree; `schema-guard.ts` fails the spec
 * on every operation and pair NOT listed here.
 *
 * Be honest about what a waiver buys. Like `--update-baseline` on the docs gate,
 * it cannot stop a wrong answer — a wrong entry here gets today's outcome. What
 * it removes is the **silence**: before this file existed, a mock the server
 * could never produce generated no signal anywhere in the pipeline.
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
 *   chasing. `'*'` costs enforcement on the other properties of these 89
 *   operations and buys a ledger that does not flake. Use the property-level
 *   form for anything added from here, where you know the one line you mean.
 * · Every reason names the issue that removes it. A waiver with no issue is a
 *   bug waiting to be re-found, and `scripts/check-e2e-schema-guard.sh` rejects
 *   one. That script also ratchets the entry count: it may shrink — and when it
 *   does, the budget must be lowered in the same MR — never grow.
 *
 * ## The clusters, and which side is wrong
 *
 * Each was verified against the Django source; the cluster says which artifact to
 * change, which is the part a bare "mismatch" cannot tell you. The letters are
 * stable, so a closed cluster ((b), (c), (d), (f)) leaves a gap.
 *
 * **(a) SCHEMA WRONG** — the server sends the field or body shape and the
 * published response does not declare it. "Fixing" the mock would make it wrong.
 *
 * **(e) #2633 — user ids are integers.** `created_by`, `lead`, `user` and
 * friends are `AutoField` integer PKs; many fixtures still send strings.
 *
 * **(g) TEST AHEAD OF SERVER** — a field the client reads that this one endpoint
 * has not shipped.
 *
 * **(h) APP READS A FIELD NO SERIALIZER SENDS** — the component depends on it, so
 * the feature behind it cannot render against the real server. Deleting it from
 * the mock only hides that; the serializer or the component has to change.
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
  // (h) APP READS A FIELD NO SERIALIZER SENDS - product question, not a fixture fix - 4 operations
  // ---------------------------------------------------------------------------
  'GET /api/v1/resources/': {
    reason:
      'PRODUCT (found by #3654): useResources maps `is_deleted` to the Deactivated UI, but ' +
      'ResourceSerializer never sends it. The fixture keeps it until that is decided.',
    allow: [
      'results[].is_deleted:unknown-property',
    ],
  },
  'GET /api/v1/tasks/': {
    reason:
      'PRODUCT (found by #3654): ConversionNotice keys on `auto_container`, but ' +
      'TaskSerializer never sends it. The fixture keeps it until that is decided.',
    allow: [
      'results[].auto_container:unknown-property',
    ],
  },
  'POST /api/v1/resources/': {
    reason:
      'PRODUCT (found by #3654): useResources maps `is_deleted` to the Deactivated UI, but ' +
      'ResourceSerializer never sends it. The fixture keeps it until that is decided.',
    allow: [
      'is_deleted:unknown-property',
    ],
  },
  'POST /api/v1/resources/{id}/restore/': {
    reason:
      'PRODUCT (found by #3654): useResources maps `is_deleted` to the Deactivated UI, but ' +
      'ResourceSerializer never sends it. The fixture keeps it until that is decided.',
    allow: [
      'is_deleted:unknown-property',
    ],
  },
  // ---------------------------------------------------------------------------
  // (a) SCHEMA WRONG - the server sends it, the published response does not declare it - 11 operations
  // ---------------------------------------------------------------------------
  'GET /api/v1/programs/{program_pk}/label-tasks/': {
    reason:
      'SCHEMA-WRONG (found by #3654): the view adds `withheld_project_count` to the ' +
      'paginated envelope after serialization. The mock matches the server; fix the schema.',
    allow: [
      'withheld_project_count:unknown-property',
    ],
  },
  'PATCH /api/v1/projects/{id}/tasks/classification/': {
    reason:
      'SCHEMA-WRONG (found by #3654): the view sends `capabilities_denied`. The mock ' +
      'matches the server; fix the schema.',
    allow: [
      'capabilities_denied:unknown-property',
    ],
  },
  'PATCH /api/v1/tasks/{id}/': {
    reason:
      'SCHEMA-WRONG (found by #3654): the lost-update 409 body ' +
      '(conflict_fields/server_value/client_value/server_version) is sent, but only ' +
      'StructureRoleConflict is declared for 409. The mock matches the server; fix the ' +
      'schema.',
    allow: [
      'client_value:unknown-property',
      'conflict_fields:unknown-property',
      'server_value:unknown-property',
      'server_version:unknown-property',
    ],
  },
  'PATCH /api/v1/teams/{team_pk}/members/{id}/': {
    reason:
      'SCHEMA-WRONG (found by #3654): partial_update answers with ' +
      'TeamMembershipReadSerializer; the write serializer is declared. The mock matches the ' +
      'server; fix the schema.',
    allow: [
      'id:unknown-property',
      'role_label:unknown-property',
      'user:unknown-property',
      'user_detail:unknown-property',
    ],
  },
  'POST /api/v1/me/api-tokens/': {
    reason:
      'SCHEMA-WRONG (found by #3654): the create view adds the one-time raw `token` to the ' +
      'response. The mock matches the server; fix the schema.',
    allow: [
      'token:unknown-property',
    ],
  },
  'POST /api/v1/programs/{program_pk}/api-tokens/': {
    reason:
      'SCHEMA-WRONG (found by #3654): the create view adds the one-time raw `token` to the ' +
      'response. The mock matches the server; fix the schema.',
    allow: [
      'token:unknown-property',
    ],
  },
  'POST /api/v1/programs/{program_pk}/mention-groups/': {
    reason:
      'SCHEMA-WRONG (found by #3654): create answers with the read serializer; the write ' +
      'serializer is declared. The mock matches the server; fix the schema.',
    allow: [
      'id:unknown-property',
      'member_count:unknown-property',
      'members:unknown-property',
      'muted_by_me:unknown-property',
      'program:unknown-property',
      'server_version:unknown-property',
    ],
  },
  'POST /api/v1/projects/{project_pk}/api-tokens/': {
    reason:
      'SCHEMA-WRONG (found by #3654): the create view adds the one-time raw `token` to the ' +
      'response. The mock matches the server; fix the schema.',
    allow: [
      'token:unknown-property',
    ],
  },
  'POST /api/v1/projects/{project_pk}/mention-groups/': {
    reason:
      'SCHEMA-WRONG (found by #3654): create answers with the read serializer; the write ' +
      'serializer is declared. The mock matches the server; fix the schema.',
    allow: [
      'id:unknown-property',
      'member_count:unknown-property',
      'members:unknown-property',
      'muted_by_me:unknown-property',
      'project:unknown-property',
      'server_version:unknown-property',
    ],
  },
  'POST /api/v1/sprints/{id}/activate/': {
    reason:
      'SCHEMA-WRONG (found by #3654): the view adds `warnings` after serialization. The ' +
      'mock matches the server; fix the schema.',
    allow: [
      'warnings:unknown-property',
    ],
  },
  'POST /api/v1/task-resources/': {
    reason:
      'SCHEMA-WRONG (found by #3654): the view adds `warnings` after serialization. The ' +
      'mock matches the server; fix the schema.',
    allow: [
      'warnings:unknown-property',
    ],
  },
  // ---------------------------------------------------------------------------
  // (e) #2633 - user ids are integers server-side, strings in types.ts - 30 operations
  // ---------------------------------------------------------------------------
  'GET /api/v1/agent-actions/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'results[].principal:type',
    ],
  },
  'GET /api/v1/me/notifications/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'results[].recipient:type',
    ],
  },
  'GET /api/v1/programs/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'results[].created_by:type',
      'results[].lead:type',
      'results[].lead_detail.id:type',
    ],
  },
  'GET /api/v1/programs/{id}/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'created_by:type',
      'lead:type',
      'lead_detail.id:type',
    ],
  },
  'GET /api/v1/programs/{program_pk}/backlog-items/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'results[].created_by:type',
    ],
  },
  'GET /api/v1/programs/{program_pk}/ceremonies/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'results[].created_by:type',
    ],
  },
  'GET /api/v1/programs/{program_pk}/members/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      '[].user:type',
      '[].user_detail.id:type',
    ],
  },
  'GET /api/v1/projects/{id}/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'lead:type',
      'lead_detail.id:type',
    ],
  },
  'GET /api/v1/projects/{project_pk}/members/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      '[].user:type',
      '[].user_detail.id:type',
    ],
  },
  'GET /api/v1/projects/{project_pk}/mention-groups/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      '[].members[].id:type',
    ],
  },
  'GET /api/v1/projects/{project_pk}/risks/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'results[].owner:type',
    ],
  },
  'GET /api/v1/teams/{team_pk}/members/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'results[].user:type',
      'results[].user_detail.id:type',
    ],
  },
  'PATCH /api/v1/me/notifications/{id}/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'recipient:type',
    ],
  },
  'PATCH /api/v1/programs/{id}/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'created_by:type',
      'lead_detail.id:type',
    ],
  },
  'PATCH /api/v1/programs/{program_pk}/backlog-items/{id}/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'created_by:type',
    ],
  },
  'PATCH /api/v1/programs/{program_pk}/ceremonies/{id}/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'created_by:type',
    ],
  },
  'PATCH /api/v1/projects/{id}/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'lead:type',
      'lead_detail.id:type',
    ],
  },
  'PATCH /api/v1/projects/{project_pk}/members/{id}/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'user:type',
      'user_detail.id:type',
    ],
  },
  'POST /api/v1/me/notifications/{id}/snooze/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'recipient:type',
    ],
  },
  'POST /api/v1/programs/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'created_by:type',
    ],
  },
  'POST /api/v1/programs/load-sample/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'program.created_by:type',
    ],
  },
  'POST /api/v1/programs/{id}/close/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'closed_by:type',
      'created_by:type',
    ],
  },
  'POST /api/v1/programs/{id}/transfer-sponsorship/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'created_by:type',
    ],
  },
  'POST /api/v1/programs/{program_pk}/backlog-items/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'created_by:type',
    ],
  },
  'POST /api/v1/programs/{program_pk}/ceremonies/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'created_by:type',
    ],
  },
  'POST /api/v1/programs/{program_pk}/members/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'user:type',
      'user_detail.id:type',
    ],
  },
  'POST /api/v1/projects/{id}/archive/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'archived_by:type',
    ],
  },
  'POST /api/v1/projects/{project_pk}/members/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'user:type',
      'user_detail.id:type',
    ],
  },
  'POST /api/v1/velocity-suggestions/{id}/accept/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'accepted_by:type',
    ],
  },
  'POST /api/v1/velocity-suggestions/{id}/dismiss/': {
    reason:
      '#2633: user ids are integer AutoField PKs server-side; these fixtures still send ' +
      'strings.',
    allow: [
      'dismissed_by:type',
    ],
  },
  // ---------------------------------------------------------------------------
  // (g) TEST AHEAD OF SERVER - a client field not yet emitted by this endpoint - 1 operation
  // ---------------------------------------------------------------------------
  'GET /api/v1/me/work/': {
    reason:
      'TEST-AHEAD-OF-SERVER (#1753): the client reads `is_phase` on My Work rows and ' +
      'schedule-add-phase.spec.ts seeds it, but MeWorkTaskSerializer does not emit it.',
    allow: [
      'results[].is_phase:unknown-property',
    ],
  },
};
