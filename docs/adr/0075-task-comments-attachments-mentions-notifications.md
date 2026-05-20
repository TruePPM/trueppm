# ADR-0075: Task Attachments, Comments, @Mentions, and Notification Surface (OSS Foundation for #476)

## Status

Proposed

## Context

Three OSS issues in the milestone-0.2 task-drawer cluster need a unified architectural answer:

- **#310 — Task attachments** (file uploads + pinned external URLs)
- **#311 — Task comments thread** (with @mention, reactions, single-level nesting)
- **#476 — Notes + Decision toggle + @mention + auto-groups** (deferred multi-week; per-author timestamped entries with a sprint/project Decisions view)

#476 was the first of these to be scoped and its V2 reshape (panel avg 6.25/10, Alex+Jordan delight signal) introduced the @mention syntax, auto-groups derived from project RBAC, a `scope` field on mentions for Morgan's team-private/PMO-opt-in visibility gate, and email-default-OFF notifications per Priya's V2 request. With #476 deferred, **#311 becomes the first issue to ship the @mention/notification infrastructure** that #476 will later reuse — *or* #311 ships its own thin version and #476 builds the real thing later, doubling the surface.

Both VoC panels (#476 V2 and the combined #310+#311 V2 — avg 5.25/10, two 🔴 altitude mismatches) raised the same unanimous concern: **two notification surfaces is a Priya-churn trigger and an Alex/Jordan trust trigger.** The architectural decision must commit to a single contract now even though #476 ships later.

ADR-0044 explicitly deferred @mentions on `RiskComment` to Enterprise scope; this ADR is OSS's first real @mention surface. ADR-0049 specced `NOTIFICATION_CHANNELS` as an extension-point registry (`in_app`/`email` for OSS, `slack_dm`/`teams_dm`/`sms` for Enterprise) but the registry has had no real consumer until now. ADR-0029's slot-registry pattern remains the OSS/Enterprise boundary.

P3M layer: **Programs/Projects + Operations.** OSS by every classification test (passes adoption-lens; collaboration is table stakes; no governance overlay in this ADR's scope — overlays live in trueppm-enterprise#109, #111).

## Seven critiques the panel raised (architect must resolve all)

1. One unified notification surface, not two
2. Attachments task-first-class, comments reference by id (not comment-owned storage)
3. Flat + one-level reply nesting (Linear/Jira convention)
4. ✅ acknowledgement is structurally different from 👍 chatter (separate models, separate visibility)
5. Mention-only notification default (no thread-subscription model — Slack pattern everyone mutes)
6. `scope` field on mentions from day one (so #476's team-private Decisions visibility gate inherits cleanly)
7. Offline write queue (web in 0.2; mobile when ADR-0026 lands)

## Decision

### A. Data model — five new OSS entities + one extension-point registry consumer

#### A.1 `TaskAttachment` (in `apps/projects/models.py`)

```python
class TaskAttachment(models.Model):
    """File or external link attached to a task. First-class; referenced by comments.
    Plain Model (not VersionedModel) — synced via direct REST in 0.2; mobile sync
    integration deferred to post-ADR-0026."""
    id = UUIDField(primary_key=True, default=uuid4)
    task = ForeignKey(Task, CASCADE, related_name="attachments")

    # XOR: file XOR external_url (DB CheckConstraint)
    file = FileField(upload_to="attachments/%Y/%m/", null=True, blank=True)
    file_name = CharField(max_length=255, blank=True, default="")
    file_size = BigIntegerField(null=True, blank=True)  # bytes
    file_mime = CharField(max_length=128, blank=True, default="")
    external_url = URLField(max_length=2048, null=True, blank=True)
    external_title = CharField(max_length=255, blank=True, default="")

    is_pinned = BooleanField(default=False)
    uploaded_by = ForeignKey(User, SET_NULL, null=True, related_name="+")
    deleted_by = ForeignKey(User, SET_NULL, null=True, related_name="+")  # threat-model R: who soft-deleted
    created_at = DateTimeField(auto_now_add=True)
    is_deleted = BooleanField(default=False, db_index=True)
    deleted_at = DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            CheckConstraint(
                check=(Q(file__isnull=False, external_url__isnull=True) |
                       Q(file__isnull=True, external_url__isnull=False)),
                name="attachment_file_xor_url",
            ),
        ]
        indexes = [Index(fields=["task", "is_deleted", "-created_at"])]
```

Soft-delete (not hard) so comments that reference the attachment via `[[attachment:uuid]]` markdown still render gracefully ("deleted attachment") rather than 404. `deleted_by` captures the actor without requiring full Enterprise audit trail (#113) — cheap OSS-side accountability hook.

#### A.2 `TaskComment` (in `apps/projects/models.py`)

```python
class TaskComment(models.Model):
    """Mirrors RiskComment (ADR-0044) shape. Plain Model, append-only with edit
    window, one-level reply nesting enforced at app layer."""
    id = UUIDField(primary_key=True, default=uuid4)
    task = ForeignKey(Task, CASCADE, related_name="comments")
    parent = ForeignKey("self", CASCADE, null=True, blank=True, related_name="replies")
    author = ForeignKey(User, SET_NULL, null=True, related_name="+")
    body = TextField()  # renderable markdown w/ [[attachment:uuid]] + @mention syntax
    edited_at = DateTimeField(null=True, blank=True)
    created_at = DateTimeField(auto_now_add=True, db_index=True)
    is_deleted = BooleanField(default=False)
    deleted_at = DateTimeField(null=True, blank=True)
    deleted_by = ForeignKey(User, SET_NULL, null=True, related_name="+")  # threat-model R

    class Meta:
        ordering = ["created_at"]
        indexes = [Index(fields=["task", "is_deleted", "created_at"])]
```

One-level reply enforced in `TaskCommentSerializer.validate_parent()`: if `parent.parent_id IS NOT NULL`, reject. A future DB trigger can promote this to a hard constraint if needed.

**Body length cap**: `body` is validated to ≤ 10 000 chars at the serializer layer (see "Locked-in constraints" below). Edit window: 15 min after `created_at` — after that, `body` is read-only.

#### A.3 `CommentAcknowledgement` (in `apps/projects/models.py`)

```python
class CommentAcknowledgement(models.Model):
    """First-class ack signal: 'I saw this' / 'I'm on it'. Queryable for team health
    (Alex's 'unacknowledged @mentions' view). NEVER triggers notification."""
    id = UUIDField(primary_key=True, default=uuid4)
    comment = ForeignKey(TaskComment, CASCADE, related_name="acknowledgements")
    user = ForeignKey(User, CASCADE, related_name="+")
    created_at = DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [("comment", "user")]
```

Visibility: team can query acknowledgements; PMO query is permission-gated server-side (per Morgan's "not auto-exposed to PMO" requirement). Enforced in the viewset, not the model.

#### A.4 `CommentReaction` (in `apps/projects/models.py`)

```python
class CommentReaction(models.Model):
    """Lightweight emoji reaction. NEVER triggers notification. NO ack semantics."""
    id = UUIDField(primary_key=True, default=uuid4)
    comment = ForeignKey(TaskComment, CASCADE, related_name="reactions")
    user = ForeignKey(User, CASCADE, related_name="+")
    emoji = CharField(max_length=16)  # 0.2 allow-list: ["👍"] only
    created_at = DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [("comment", "user", "emoji")]
```

0.2 ships allow-list of one emoji (👍). Full emoji picker deferred to 0.3 per Jordan's "no 😂 on a bug report" concern. Acknowledgement and reaction stay structurally separate per Morgan's blocker.

#### A.5 `Mention` (in new `apps/notifications/models.py`)

```python
class MentionScope(models.TextChoices):
    PROJECT_VISIBLE = "project_visible", "Project visible"  # default for comments
    TEAM_ONLY = "team_only", "Team only"                    # #476 team-private Decisions
    PRIVATE = "private", "Private"                          # future: DM-style


class Mention(models.Model):
    """Append-only @mention record. Polymorphic source via nullable FKs (one required).
    Stores both the target user AND the group key (snapshot) for audit/display."""
    id = UUIDField(primary_key=True, default=uuid4)
    mentioner = ForeignKey(User, SET_NULL, null=True, related_name="+")

    # Target — either a direct user or a group (snapshot expanded to Notifications)
    mentioned_user = ForeignKey(User, SET_NULL, null=True, related_name="mentions_received")
    mentioned_group_key = CharField(max_length=32, null=True, blank=True)  # 'admins', 'scrum-team', ...

    # Polymorphic source — exactly one set (CheckConstraint). New source types
    # extend via additional nullable FKs (#476 will add task_note).
    task_comment = ForeignKey(TaskComment, CASCADE, null=True, related_name="mentions")
    # (Future: task_note = ForeignKey(TaskNote, CASCADE, null=True, related_name="mentions"))

    project = ForeignKey(Project, CASCADE, db_index=True)  # for queries scoped to a project
    scope = CharField(max_length=32, choices=MentionScope.choices,
                      default=MentionScope.PROJECT_VISIBLE)
    created_at = DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        constraints = [
            CheckConstraint(
                check=(Q(mentioned_user__isnull=False) | Q(mentioned_group_key__isnull=False)),
                name="mention_must_have_target",
            ),
            CheckConstraint(
                check=Q(task_comment__isnull=False),
                # When #476 ships task_note, change to: task_comment OR task_note
                name="mention_must_have_source",
            ),
        ]
        indexes = [
            Index(fields=["mentioned_user", "-created_at"], name="ix_mention_user_recent"),
            Index(fields=["project", "-created_at"], name="ix_mention_project_recent"),
        ]
```

`scope` is stubbed to `PROJECT_VISIBLE` for 0.2 (comments). #476 fills in `TEAM_ONLY` for team-private Decisions and the visibility gate on the Decisions view. Bolting `scope` on later would be expensive; building the skeleton now costs almost nothing.

Group mentions snapshot to per-user Notification rows at write time. The `mentioned_group_key` stays on the Mention for "@scrum-team was mentioned" display.

**Scope-respecting queryset pattern (threat-model 🔴 must-fix)**: all `Mention.objects` queries MUST go through a scope-respecting manager method:

```python
class MentionManager(models.Manager):
    def visible_to(self, user, project_id=None):
        """Returns mentions the user is allowed to see based on scope + membership."""
        qs = self.get_queryset().filter(...)  # project membership check
        # Filter by scope: PROJECT_VISIBLE → all project members; TEAM_ONLY → team only
        return qs

class Mention(models.Model):
    objects = MentionManager()
    ...
```

Raw `.filter()` in viewsets is forbidden. This is the single point of enforcement that #476's `TEAM_ONLY` scope hangs on — a developer adding a new endpoint that bypasses `visible_to()` leaks scoped content. Lint rule or code-review checklist item required.

#### A.6 `Notification` (in new `apps/notifications/models.py`)

```python
class Notification(models.Model):
    """Per-recipient unread notification. Generated from Mentions (0.2) and future
    event types. Single inbox surface — every #476 mention lands here unchanged."""
    id = UUIDField(primary_key=True, default=uuid4)
    recipient = ForeignKey(User, CASCADE, related_name="notifications")

    # Source — nullable FKs (exactly one set in 0.2; extends as new event types arrive)
    mention = ForeignKey(Mention, CASCADE, null=True, related_name="notifications")

    project = ForeignKey(Project, CASCADE, db_index=True)  # for cross-project queries

    is_read = BooleanField(default=False, db_index=True)
    is_archived = BooleanField(default=False)
    created_at = DateTimeField(auto_now_add=True, db_index=True)
    read_at = DateTimeField(null=True, blank=True)

    # Email delivery state (best-effort via drain task)
    email_pending = BooleanField(default=False, db_index=True)
    email_sent_at = DateTimeField(null=True, blank=True)
    email_failed_at = DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            Index(fields=["recipient", "is_read", "-created_at"], name="ix_notif_unread"),
        ]
```

#### A.7 `NotificationPreference` (in new `apps/notifications/models.py`)

Consumes ADR-0049's `NOTIFICATION_CHANNELS` registry as first real client.

```python
class NotificationPreference(models.Model):
    """Per-user channel preference, per event type. Defaults set on user-create
    signal; overrides via PATCH /api/v1/me/notification-preferences/..."""
    user = ForeignKey(User, CASCADE, related_name="notification_preferences")
    event_type = CharField(max_length=64)  # 'mention_individual', 'mention_group'
    channel = CharField(max_length=32)  # 'in_app', 'email' (OSS); ADR-0049 Enterprise extends
    enabled = BooleanField()

    class Meta:
        unique_together = [("user", "event_type", "channel")]
```

**Defaults from V2 VoC** (set on user create + on first access):

| event_type | channel | default |
|---|---|---|
| `mention_individual` | `in_app` | ON |
| `mention_individual` | `email` | **OFF** (Priya's flip) |
| `mention_group` | `in_app` | ON |
| `mention_group` | `email` | **OFF** |

Per-group mute is layered as a separate model in #476's "user-defined groups" follow-up (#515/#516) — not in 0.2 scope.

### B. Attachment-by-reference (resolves comment-attachment debate)

Comment body uses inline markdown `[[attachment:<uuid>]]` syntax. Frontend renderer:

- Resolves to existing TaskAttachment in the same task scope → inline preview
- Resolves to soft-deleted attachment → "📎 (deleted attachment)" placeholder, comment text preserved
- Resolves to attachment on a different task (cross-task ref) → 0.2 rejects at composer; future may allow with explicit permission check

Sarah's "inline photo on comment" use case: open task, tap "Attach photo" (creates TaskAttachment on the task), then composer auto-inserts `[[attachment:uuid]]` into the open reply. Single source of truth; deletes don't orphan.

### C. Auto-group resolver (`apps/access/groups.py` — new module)

```python
def resolve_group_members(project_id: UUID, group_key: str) -> list[UUID]:
    """Snapshot resolver: returns user IDs that match the group at this moment.
    Used at @mention write time to fan out Notification rows."""
    if group_key == "all":
        return list(ProjectMembership.objects
                    .filter(project_id=project_id, is_deleted=False)
                    .values_list("user_id", flat=True))

    # Role-based groups (band-boundary semantics per ADR-0072)
    role_floors = {
        "owners":     Role.OWNER,
        "admins":     Role.ADMIN,
        "schedulers": Role.SCHEDULER,
        "members":    Role.MEMBER,
        "viewers":    Role.VIEWER,
    }
    if group_key in role_floors:
        return list(ProjectMembership.objects
                    .filter(project_id=project_id, role__gte=role_floors[group_key],
                            is_deleted=False)
                    .values_list("user_id", flat=True))

    if group_key == "scrum-team":
        return list(Task.objects
                    .filter(project_id=project_id, is_deleted=False, assignee__isnull=False,
                            sprint__state=SprintState.ACTIVE, sprint__is_deleted=False)
                    .values_list("assignee_id", flat=True).distinct())

    raise InvalidGroupKeyError(group_key)
```

**Snapshot at write time** (not dynamic):

- New member joining mid-thread does NOT retroactively get notified (acceptable — they can be re-mentioned)
- Departed member does NOT keep getting notified (correct — Slack/GitHub/Jira pattern)
- The original `mentioned_group_key` is preserved on the Mention row for audit/display

### D. WebSocket broadcast strategy

Reuses `broadcast_board_event(project_id, event_type, payload)` from `apps/sync/broadcast.py`. Two new event types:

- `task_comment_created` / `task_comment_updated` / `task_comment_deleted` → `{id, task_id, parent_id}` (no body)
- `task_attachment_created` / `task_attachment_deleted` → `{id, task_id}` (no body)

The `task_` prefix disambiguates from RiskComment's pre-existing `comment_created` event (ADR-0044). Without the prefix, frontend handlers would have to inspect payload keys (`task_id` vs `risk_id`) to route the invalidation, and any consumer that subscribed before the split would invalidate the wrong cache.

**Broadcast is always project-wide.** The `scope` field gates VIEW access (serializer respects scope) and NOTIFICATION creation, not broadcast. Clients refetch via REST after a broadcast; scope is enforced in the queryset / serializer.

For comments with `scope=team_only` (future #476 Decisions case): the WebSocket payload is identical (id + action only); the REST refetch is the enforcement point. This matches ADR-0074's aggregated-only payload principle and avoids body leakage through Channels.

### E. Acknowledgement-as-signal vs reaction-as-chatter

Two separate models (A.3 and A.4) per Morgan's blocker. Key differences:

| | `CommentAcknowledgement` | `CommentReaction` |
|---|---|---|
| Triggers notification | Never | Never |
| PMO-queryable | No (team-only viewset) | Yes (low-stakes data) |
| Surfaces "unacknowledged @mentions" | Yes (Alex's team health view) | No |
| Cardinality | one per (comment, user) | one per (comment, user, emoji) |
| 0.2 UI | ✅ chip | 👍 chip |

### F. Mobile / offline write queue

0.2 ships **web-only offline queue** (IndexedDB-backed):

- Comment writes queued with client UUIDs; flush on reconnect
- Attachment uploads queued with file blob in IndexedDB; flush on reconnect
- Conflict resolution: last-write-wins on comment edit (comments edited rarely; merge UX is overkill — Priya's "I'll never re-fetch" pattern)
- Idempotency: client-generated UUID prevents duplicate inserts on retry

Mobile WatermelonDB integration: **deferred to post-ADR-0026** (no mobile package exists yet in `packages/`). All models use UUID PKs and soft-delete so the future mobile sync is unblocked.

### G. Apache 2.0 boundary check

- All new models live in OSS apps (`projects/` and a new `notifications/` app)
- Zero imports from `trueppm_enterprise`
- ADR-0049's `NOTIFICATION_CHANNELS` registry handles channel extensibility — Enterprise registers slack_dm/teams_dm/sms in its own AppConfig.ready()
- Audit trail / approval workflows / SCIM stay in trueppm-enterprise#109; they hook stable signals on Mention / Notification models
- Boundary CI check (`grep -r 'trueppm_enterprise' packages/`) remains at zero hits in real imports

## Locked-in constraints (from threat-model)

The threat-model pass (paired with this ADR) identified five 🔴 must-fix items and locked numeric values for thirteen constraints. Implementation MUST enforce all of the below; tests MUST assert each one.

| # | Constraint | Value | Enforcement layer |
|---|---|---|---|
| 1 | `@all` group resolve cardinality cap | **200 users** | `apps/access/groups.py::resolve_group_members()` — raises `GroupTooLargeError` |
| 2 | `@all` role gate | **ADMIN+ required** | Mention parser at serializer layer |
| 3 | Comment body max length | **10 000 chars** | `TaskCommentSerializer.validate_body()` |
| 4 | Attachment file size max | **100 MB** | Upload handler — reject before disk write |
| 5 | MIME allow-list (0.2) | `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (xlsx), `text/csv`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (docx) | Magic-bytes sniff at upload handler; unknown MIME = 415 |
| 6 | Signed URL default TTL | **15 minutes** | `TaskAttachment.signed_url_for()` |
| 7 | Signed URL max TTL (OSS hard-cap) | **60 minutes** | Same; reject longer requests with 400. Enterprise (#113) lifts the cap with audit hooks. |
| 8 | Mention rate-limit per user (daily) | **1000 mentions/day** | DRF throttle class on comment-create + (future) note-create |
| 9 | Mention rate-limit per user (hourly burst) | **100 mentions/hour** | Same throttle, burst window |
| 10 | `mentioned_user` not a project member | **Reject at write time (400)** | Mention parser |
| 11 | Comment edit window | **15 min** from `created_at` | `TaskCommentSerializer.update()` |
| 12 | Per-task attachment count cap | **50** | Pre-save check in `TaskAttachmentSerializer.create()` — 409 on cap |
| 13 | Per-task comment count cap | **1000** | Same pattern as 12 |

Additional must-fix items not numeric:

- **Acknowledgement viewset team-only** (Morgan blocker): `CommentAcknowledgementViewSet` exposes ack list only to comment authors + the acknowledger themselves. Aggregate-count endpoint forbidden in OSS. Integration test: ADMIN-role user not involved in the task gets empty result.
- **`Mention.objects.visible_to(user)` queryset pattern**: see Mention section above. Lint or review checklist.
- **No body in WebSocket payload**: typed broadcast helper in `apps/sync/broadcast.py` rejects body fields by construction; code-review checklist item.
- **`deleted_by` on TaskAttachment + TaskComment**: see model definitions above.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| GenericForeignKey on Mention.source | Future-flexible, no schema migration per source type | ContentType lookups; harder to query efficiently; team aversion |
| Nullable-FK polymorphism (chosen) | Explicit, queryable, FK constraints enforce referential integrity | One small migration per new source type (#476 adds `task_note`) |
| Single `Reaction` table with `is_ack` discriminator | DRY (one model) | Conflates ack-as-signal with chatter; Morgan blocker (visibility gates differ) |
| Comment-attached file storage | Sarah's inline-photo case is literal | Marcus/Morgan footgun (delete comment → lose artifact); duplicate storage; orphan management |
| Thread-subscription notification model | Matches Slack power-user UX | Priya 🔴 (gets muted within a week); contradicts mention-only default |
| Per-project notification preference | Granular control | Bookkeeping burden; default-OFF email is sufficient for 0.2 |
| Dynamic group resolution at notification-display time | New members get retroactive notifications | Departed members keep being pinged (worse failure mode) |
| Body in WebSocket payload | Fewer round-trips | Leaks scoped content; contradicts ADR-0074 aggregated-only principle |

## Consequences

**Easier:**

- #476 (deferred) inherits Mention + Notification surface unchanged — just adds `task_note` FK on Mention and rides the existing snapshot resolver
- Enterprise trueppm-enterprise#109 (group governance overlay), #110 (portfolio Decision rollup), #111 (Decision audit immutability) all hook stable signals on Mention/Notification — no model rewrite
- ADR-0049's `NOTIFICATION_CHANNELS` registry gets its first real consumer; pattern is now exercised
- Sarah's V2 7/10 path: attachments + comment-by-reference + offline queue (web) — closer to her 10/10 anchor once mobile lands
- Alex's "unacknowledged @mentions in team health view" is a single SQL query on `CommentAcknowledgement`

**Harder:**

- Web-only offline queue means Sarah's mobile case isn't covered until mobile package exists (acceptable: post ADR-0026 work)
- Snapshot-at-write for auto-groups means @scrum-team mentions don't follow new sprint members joining mid-discussion (acceptable: matches Slack/GitHub/Jira)
- One-level reply nesting enforced at app layer (validation in serializer); strict DB enforcement would require a trigger (deferred)
- Notification preferences UI has to balance "default-OFF email" + "per-user override" + "future Enterprise channels" without overwhelming Priya — grouped defaults in the UI ("Email me when…") will need ux-design attention

**Risks:**

- Comment-by-reference attachment rendering: if frontend doesn't render `[[attachment:uuid]]` markdown, raw markup leaks. Mitigation: golden-path test that asserts rendered output never contains the literal `[[attachment:` substring.
- Mention parser must escape `@` in code blocks / quoted text (XSS-adjacent and content-misclassification). Covered in threat-model.
- Snapshot-resolver fairness: if `@all` resolves to 200+ users, fan-out creates 200+ Notification rows in one transaction. Mitigate with batch insert + per-project mention rate-limit (defer to ops, not in 0.2 scope).
- WebSocket broadcast scope: if a future scope value is introduced and developers forget to update the consumer's REST refetch, scoped content could leak. Mitigation: scope enforcement lives in the serializer/queryset (single point of control), not in the consumer.

## Implementation Notes

- **P3M layer**: Operations + Programs/Projects
- **Affected packages**: api (new models + endpoints + services), web (drawer surfaces, notification feed, composer); mobile (model is mobile-ready; sync wiring deferred to post-ADR-0026)
- **Migration required**: yes
  - `apps/projects/migrations/0038_task_attachments_comments.py` — TaskAttachment, TaskComment, CommentAcknowledgement, CommentReaction
  - `apps/notifications/migrations/0001_initial.py` — Mention, Notification, NotificationPreference (new app)
- **API changes**: yes — see API surface below
- **OSS or Enterprise**: OSS (`trueppm-suite`)

### API surface

```
# Comments (mirrors RiskComment URL shape)
GET    /api/v1/projects/{project_id}/tasks/{task_id}/comments/
POST   /api/v1/projects/{project_id}/tasks/{task_id}/comments/
PATCH  /api/v1/projects/{project_id}/tasks/{task_id}/comments/{id}/
DELETE /api/v1/projects/{project_id}/tasks/{task_id}/comments/{id}/

POST   /api/v1/projects/{project_id}/tasks/{task_id}/comments/{id}/acknowledge/
DELETE /api/v1/projects/{project_id}/tasks/{task_id}/comments/{id}/acknowledge/

POST   /api/v1/projects/{project_id}/tasks/{task_id}/comments/{id}/reactions/   { emoji: "👍" }
DELETE /api/v1/projects/{project_id}/tasks/{task_id}/comments/{id}/reactions/{id}/

# Attachments
GET    /api/v1/projects/{project_id}/tasks/{task_id}/attachments/
POST   /api/v1/projects/{project_id}/tasks/{task_id}/attachments/         (multipart: file XOR external_url)
DELETE /api/v1/projects/{project_id}/tasks/{task_id}/attachments/{id}/
GET    /api/v1/projects/{project_id}/tasks/{task_id}/attachments/{id}/signed-url/
       returns 200 { "url": "...", "expires_at": "..." }

# Per-user notification inbox
GET    /api/v1/me/notifications/                ?unread_only=true&limit=50&cursor=...
PATCH  /api/v1/me/notifications/{id}/           { is_read: true }
POST   /api/v1/me/notifications/mark-all-read/

# Per-user preferences
GET    /api/v1/me/notification-preferences/
PATCH  /api/v1/me/notification-preferences/{event_type}/{channel}/   { enabled: bool }
```

### WebSocket events (on existing `project_{id}` channel)

```
task_comment_created     { id, task_id, parent_id? }
task_comment_updated     { id, task_id, parent_id? }
task_comment_deleted     { id, task_id, parent_id? }
task_attachment_created  { id, task_id }
task_attachment_deleted  { id, task_id }
```

Aggregated metadata only — no body. Clients refetch via REST (scope enforced there).

**Naming convention** (broadcast-check M-1, amended after merge): per-action past-tense events with no `action` discriminator. Aligns with `task_updated`, `risk_deleted`, `milestone_rollup_updated` (ADR-0074), etc. The earlier `*_changed` + `action` field shape was a one-off divergence that would have forced clients to learn a second event-handling pattern; splitting at the event level keeps the existing per-event subscription model intact.

**The `task_` prefix** disambiguates from RiskComment's pre-existing `comment_created` event (ADR-0044). Without the prefix the regression-check post-M-1 audit caught a collision: a task-comment broadcast was invalidating the risk-comment cache and the new task-comment cache was never invalidated. The `task_` prefix is a hard rename, not a payload discriminator, because per-event subscription is the established invalidation pattern in `useProjectWebSocket.ts`.

### Real-time strategy for personal notifications (0.2 decision)

Personal notifications (the "My mentions" feed and unread bell badge) need real-time updates, but introducing a per-user WebSocket channel (`user_{id}`) is operationally heavier than 0.2 needs. **0.2 ships polling**:

- The unread-count bell polls `GET /me/notifications/?unread_only=true&limit=0` every **30 seconds**
- The open NotificationPanel refetches the list on every `task_comment_created` broadcast it observes on any subscribed `project_{id}` channel (an "indirect signal" — if a project I'm a member of had a new comment, it might involve a mention to me)
- Pause polling when the browser tab is hidden (Page Visibility API) — resume on visibility regain

A `user_{id}` WebSocket channel is **deferred to 0.3 as a follow-up** if polling proves too laggy in practice. The data model is unchanged either way — only the delivery shape changes. Polling at 30 s is acceptable for @mention frequency (Slack-style instant notifications are not what this surface is for; ours are deliberate "I need your input" signals).

### Durable Execution

1. **Broker-down behaviour**: Comment + attachment writes are synchronous transactional writes. Mention + Notification rows are created in the same transaction. WebSocket broadcast uses `transaction.on_commit()` per existing pattern (best-effort: broker-down = missed live update, never stale stored value). Email delivery is best-effort via outbox.
2. **Drain task**: **New** `drain_notification_emails` Beat task every 30 s, processes `Notification.email_pending=True` rows older than the orphan window.
3. **Orphan window**: 5 min (matches webhooks per ADR-0019 convention).
4. **Service layer**: **New** `notifications/services.py::create_mention_notifications(mention: Mention) -> int` — called from `TaskCommentViewSet.perform_create()` after `on_commit`. Returns count of Notification rows created.
5. **API response on best-effort dispatch**: Comment POST returns `201 Created` with the created comment (synchronous). Notification fan-out happens transactionally; email send is best-effort.
6. **Outbox cleanup**: Notifications older than 90 days **and** `is_read=True` are soft-archived (`is_archived=True`) nightly. Hard-purge of archived notifications older than 365 days is a future operational concern (not in 0.2).
7. **Idempotency**: `Mention.id` and `Notification.id` are UUIDs. Duplicate mentions in a single comment body deduplicated by app-layer parser (mention same user twice = one Mention row). Email send uses `Notification.email_sent_at` as the idempotency key.
8. **Dead-letter / failure handling**: Email send failure → `Notification.email_failed_at` set; retry budget 3 attempts with exponential backoff via the drain task. Permanent failure: in-app notification still delivered; email failure is logged but does not block the user-visible signal.

## Pairing with /threat-model

This ADR's feature surface crosses multiple trust boundaries and **requires /threat-model before implementation begins**:

- **File upload** (user-controlled content → object storage): tampering, content-type spoofing, malware uploads, path traversal in `upload_to`, signed-URL leakage
- **Mention scope** (information disclosure if scope wrong): privilege escalation through scope misconfiguration, future TEAM_ONLY leakage if PMO viewset doesn't enforce
- **WebSocket broadcast** (broadcasts to all project members regardless of scope; body intentionally excluded): downstream client must respect scope on REST refetch — single point of enforcement is the queryset
- **Notification preferences** (user-controlled prefs but enforcement is server-side): tampering on PATCH endpoint; defaults set on user-create signal
- **@mention parser** (extracting `@user` / `@group` from free-text body): XSS-adjacent escaping, content-misclassification on `@` in code blocks
- **Auto-group resolver** (snapshot fan-out): denial-of-service via `@all` mention on a 1000-member project; rate-limiting deferred to ops

STRIDE focus areas: **Tampering** on attachments, **Information Disclosure** via scope misconfiguration, **Denial of Service** via mention fan-out, **Repudiation** absent from comments in 0.2 (no edit history until Enterprise #111 lands immutability).

## Out of scope (filed elsewhere)

- Comment-attached file storage → comment-by-reference instead
- Full emoji reaction picker → 0.3 (allow-list of 👍 only in 0.2)
- Thread-subscription notification model → rejected (Priya 🔴)
- Two-surface notification UX → single inbox decided here
- Attachment audit trail (SOC 2 evidence) → file in trueppm-enterprise alongside #109
- Attachment retention policy / GDPR deletion → Enterprise concern
- Per-group mute / user-defined groups → #515 (project) + #516 (program)
- @mention notifications to mobile push → opt-in only when mobile package exists (post-ADR-0026)
- Cross-task attachment references → 0.2 rejects; future may allow with permission check
- Acknowledgement export for SOC 2 → Enterprise overlay if requested
