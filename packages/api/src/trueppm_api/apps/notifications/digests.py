"""Scheduled digest builders and the Beat sweep (ADR-0663, #2407).

The first *clock-driven* notifications in TruePPM. Everything else in this app
fires from a domain event; these fire because it is Sunday evening in the
recipient's timezone.

Three rules shape this module:

1. **No new math.** Program health comes from :func:`compute_program_rollup` and
   the contributing project from :func:`top_contributing_project` (both ADR-0088);
   overallocation comes from :func:`compute_utilization`'s ``overallocated`` flag,
   which is ``load_pct > 100`` — the same verdict the heat map colors red. A digest
   must never state a number the user cannot find on the screen it links to.
2. **No new pipeline.** Content is handed to :func:`create_event_notifications`,
   so DND, quiet hours, the per-(event, channel) matrix, the durable inbox row, and
   the ``email_pending`` outbox drain all apply unchanged.
3. **The empty digest is a real digest.** "Nothing at risk this week" is a send.
   A channel that only speaks when something is wrong teaches the reader to read
   silence as either good news or a broken pipeline, with no way to tell which.
"""

from __future__ import annotations

import datetime
import logging
import zoneinfo
from typing import TYPE_CHECKING, Any

from django.conf import settings
from django.db import IntegrityError
from django.utils import timezone

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.lifecycle import exclude_draft_projects
from trueppm_api.apps.projects.models import Program, Project
from trueppm_api.apps.projects.program_rollup import (
    compute_program_rollup,
    top_contributing_project,
)
from trueppm_api.apps.projects.utilization import compute_utilization

from .models import (
    NotificationChannel,
    NotificationDigestRun,
    NotificationEventType,
    NotificationPreference,
    UserNotificationSettings,
)
from .services import create_event_notifications

if TYPE_CHECKING:
    from collections.abc import Iterable

logger = logging.getLogger(__name__)

# Health bands that put a program in the digest. ``on_track`` and ``unknown`` are
# not "at risk" and must not pad the body — the digest's value is that a line in it
# means something.
AT_RISK_BANDS = frozenset({"at_risk", "critical"})

# Per-user work caps (ADR-0663 §Consequences). A user on a very large number of
# programs would otherwise turn one digest into an unbounded rollup sweep. The
# truncation is stated in the body rather than silently dropping lines.
MAX_PROGRAMS_PER_DIGEST = 25
MAX_PROJECTS_PER_DIGEST = 25

# The two events this module sends. Both carry the same weekly slot.
DIGEST_EVENT_TYPES = (
    NotificationEventType.PROGRAM_HEALTH_DIGEST.value,
    NotificationEventType.RESOURCE_OVERALLOCATION_DIGEST.value,
)

_HEALTH_LABELS = {"critical": "Critical", "at_risk": "At risk"}


# ---------------------------------------------------------------------------
# Slot resolution
# ---------------------------------------------------------------------------


def resolve_user_timezone(name: str) -> zoneinfo.ZoneInfo:
    """Return the ZoneInfo for *name*, falling back to the server timezone.

    A user whose stored timezone was removed from the tz database (or was never
    valid) must not break the sweep for everyone else, so an unknown key degrades
    to ``settings.TIME_ZONE`` rather than raising.
    """
    if name:
        try:
            return zoneinfo.ZoneInfo(name)
        except (zoneinfo.ZoneInfoNotFoundError, ValueError):
            logger.warning("Unknown digest timezone %r — falling back to server timezone", name)
    return zoneinfo.ZoneInfo(settings.TIME_ZONE)


def week_start_for(local_now: datetime.datetime) -> datetime.date:
    """Return the Monday of *local_now*'s week — the digest's idempotency period.

    Anchoring on Monday (not on the user's chosen send day) means changing the
    send day mid-week cannot produce a second digest for the same week.
    """
    return local_now.date() - datetime.timedelta(days=local_now.weekday())


# ---------------------------------------------------------------------------
# Content builders
# ---------------------------------------------------------------------------


def build_program_health_digest(user: Any, local_now: datetime.datetime) -> tuple[str, str]:
    """Build the (subject, body) of *user*'s weekly program-health digest.

    Covers only programs the user is a member of, and only those whose rolled-up
    health is ``at_risk`` or ``critical``. Each line names the program, its band,
    and the project contributing most to it, and points at the existing program
    overview drill-through.
    """
    program_ids = list(
        ProgramMembership.objects.filter(user=user)
        .values_list("program_id", flat=True)
        .order_by("program_id")[:MAX_PROGRAMS_PER_DIGEST]
    )
    total_memberships = ProgramMembership.objects.filter(user=user).count()

    lines: list[str] = []
    for program in Program.objects.filter(id__in=program_ids, is_deleted=False).order_by("name"):
        rollup = compute_program_rollup(program)
        health = rollup.get("program_health")
        if health not in AT_RISK_BANDS:
            continue
        label = _HEALTH_LABELS.get(health, health)
        contributor = top_contributing_project(program)
        driver = f" — driven by {contributor['name']}" if contributor else ""
        lines.append(_line(f"{program.name}: {label}{driver}", _program_url(program.id)))

    week_of = local_now.date().isoformat()
    if not lines:
        # The honest empty state. The subject distinguishes it from a digest with
        # findings so an inbox scan alone answers "is anything wrong?".
        subject = f"Program health: nothing at risk (week of {week_of})"
        body = (
            "No program you belong to is at risk or critical this week.\n\n"
            "This is a complete report, not a suppressed one — you are seeing it "
            "because the check ran and found nothing.\n"
        )
        return subject, body

    count = len(lines)
    noun = "program" if count == 1 else "programs"
    subject = f"Program health: {count} {noun} need attention (week of {week_of})"
    body = f"{count} {noun} at risk or critical this week:\n\n" + "\n".join(lines) + "\n"
    if total_memberships > MAX_PROGRAMS_PER_DIGEST:
        body += (
            f"\nShowing the first {MAX_PROGRAMS_PER_DIGEST} of {total_memberships} programs "
            "you belong to.\n"
        )
    return subject, body


def build_resource_overallocation_digest(
    user: Any, local_now: datetime.datetime
) -> tuple[str, str]:
    """Build the (subject, body) of *user*'s weekly overallocation digest.

    Covers projects where the user holds ``role >= SCHEDULER`` (the Resource
    Manager seat) — a contributor has no lever over allocation, so mailing them a
    heat-map summary would be noise. Overallocation is
    :func:`compute_utilization`'s own ``overallocated`` flag over the coming week,
    i.e. the same ``load_pct > 100`` threshold the heat map colors red.
    """
    window_start = local_now.date()
    window_end = window_start + datetime.timedelta(days=6)

    # Drafts are excluded (#2962/#3128): a resource "overallocated" by a plan nobody
    # has committed to is not overallocated, and a Resource Manager acting on that
    # line would be levelling against work that may never exist.
    #
    # Narrowed HERE, on the membership rows, rather than on the Project queryset
    # below — because ``MAX_PROJECTS_PER_DIGEST`` slices this list and
    # ``total_projects`` counts it. Excluding after the slice would let drafts
    # consume cap slots and push real projects out of the digest entirely, and
    # would leave the "showing the first N of M" footer over-reporting M. The
    # ``project__is_deleted`` clause is here for the same reason: it was applied
    # only on the Project queryset, so a soft-deleted project already burned a
    # slot and inflated M.
    audience = exclude_draft_projects(
        ProjectMembership.objects.filter(
            user=user, role__gte=Role.SCHEDULER, project__is_deleted=False
        )
    )
    project_ids = list(
        audience.values_list("project_id", flat=True).order_by("project_id")[
            :MAX_PROJECTS_PER_DIGEST
        ]
    )
    total_projects = audience.count()

    lines: list[str] = []
    projects = (
        Project.objects.filter(id__in=project_ids, is_deleted=False)
        .prefetch_related("tasks__assignments__resource__calendar__exceptions")
        .order_by("name")
    )
    for project in projects:
        util = compute_utilization(project, window_start, window_end)
        over = [r for r in util.get("resources", []) if r.get("overallocated")]
        if not over:
            continue
        names = ", ".join(sorted(r["resource_name"] for r in over))
        count = len(over)
        noun = "resource" if count == 1 else "resources"
        lines.append(
            _line(
                f"{project.name}: {count} {noun} over 100% — {names}",
                _resources_url(project.id),
            )
        )

    week_of = window_start.isoformat()
    if not lines:
        subject = f"Resource load: nobody over capacity (week of {week_of})"
        body = (
            "No resource on the projects you manage exceeds 100% capacity in the "
            "week ahead.\n\n"
            "This is a complete report, not a suppressed one — you are seeing it "
            "because the check ran and found nothing.\n"
        )
        return subject, body

    count = len(lines)
    noun = "project" if count == 1 else "projects"
    subject = f"Resource load: overallocation on {count} {noun} (week of {week_of})"
    body = (
        f"Resources over 100% capacity in the week ahead, across {count} {noun}:\n\n"
        + "\n".join(lines)
        + "\n"
    )
    if total_projects > MAX_PROJECTS_PER_DIGEST:
        body += (
            f"\nShowing the first {MAX_PROJECTS_PER_DIGEST} of {total_projects} projects "
            "you manage.\n"
        )
    return subject, body


def _frontend_base() -> str:
    """Public frontend origin, or ``""`` when unconfigured.

    Mirrors ``blocker_services.task_deep_link``: when ``FRONTEND_BASE_URL`` is
    empty — the zero-config default — there is no reachable public URL, so callers
    omit the link line entirely rather than emit a broken relative path.
    """
    return (getattr(settings, "FRONTEND_BASE_URL", "") or "").rstrip("/")


def _program_url(program_id: Any) -> str:
    base = _frontend_base()
    return f"{base}/programs/{program_id}/overview" if base else ""


def _resources_url(project_id: Any) -> str:
    base = _frontend_base()
    return f"{base}/projects/{project_id}/resources" if base else ""


def _line(text: str, url: str) -> str:
    """Render a digest bullet, appending the deep link only when one exists."""
    return f"- {text}\n  {url}" if url else f"- {text}"


_BUILDERS = {
    NotificationEventType.PROGRAM_HEALTH_DIGEST.value: build_program_health_digest,
    NotificationEventType.RESOURCE_OVERALLOCATION_DIGEST.value: (
        build_resource_overallocation_digest
    ),
}


# ---------------------------------------------------------------------------
# Sweep
# ---------------------------------------------------------------------------


def _opted_in_user_ids(event_type: str) -> set[Any]:
    """User PKs with at least one channel explicitly enabled for *event_type*.

    Both channels default to ``False`` (ADR-0663 §1), so an opted-in user
    necessarily has a stored ``NotificationPreference`` row — which is what lets
    the sweep read a handful of rows instead of scanning every user.
    """
    return set(
        NotificationPreference.objects.filter(
            event_type=event_type,
            enabled=True,
            channel__in=[NotificationChannel.IN_APP.value, NotificationChannel.EMAIL.value],
        ).values_list("user_id", flat=True)
    )


def send_due_digests(now: datetime.datetime | None = None) -> int:
    """Send every digest whose per-user slot matches *now*. Returns rows created.

    Called hourly by Beat. For each opted-in user, "now" is converted into that
    user's ``digest_timezone`` and the digest fires iff the local weekday and hour
    match their configured slot.

    Per-user failures are logged and skipped: one user's deleted program or broken
    timezone must not deny everyone else their digest.
    """
    now = now or timezone.now()
    created_total = 0

    for event_type in DIGEST_EVENT_TYPES:
        user_ids = _opted_in_user_ids(event_type)
        if not user_ids:
            continue
        settings_by_user = {
            s.user_id: s
            for s in UserNotificationSettings.objects.filter(user_id__in=user_ids).select_related(
                "user"
            )
        }
        for user_id in user_ids:
            try:
                created_total += _maybe_send_for_user(
                    user_id, settings_by_user.get(user_id), event_type, now
                )
            except Exception:
                logger.exception(
                    "Digest %s failed for user %s — continuing with remaining users",
                    event_type,
                    user_id,
                )
    return created_total


def _maybe_send_for_user(
    user_id: Any,
    user_settings: UserNotificationSettings | None,
    event_type: str,
    now: datetime.datetime,
) -> int:
    """Send *event_type* to *user_id* iff their slot matches ``now``. Rows created."""
    # A user with no settings row uses the model defaults (Sunday 17:00, server tz),
    # mirroring how an absent NotificationPreference row reads as DEFAULT_PREFERENCES.
    weekday = user_settings.digest_weekday if user_settings else 6
    hour = user_settings.digest_hour if user_settings else 17
    tz_name = user_settings.digest_timezone if user_settings else ""

    local_now = now.astimezone(resolve_user_timezone(tz_name))
    if local_now.weekday() != weekday or local_now.hour != hour:
        return 0

    period_start = week_start_for(local_now)
    try:
        _, created = NotificationDigestRun.objects.get_or_create(
            user_id=user_id, event_type=event_type, period_start=period_start
        )
    except IntegrityError:
        # Lost the race to a concurrent worker — that worker is sending it.
        return 0
    if not created:
        return 0

    user = user_settings.user if user_settings else _load_user(user_id)
    if user is None:
        return 0

    subject, body = _BUILDERS[event_type](user, local_now)
    # project_id is None: a digest spans a user's whole membership set and is not
    # scoped to one project. The inbox row's links live in the body.
    count = create_event_notifications(
        event_type=event_type,
        recipient_ids=[user_id],
        subject=subject,
        body=body,
        project_id=None,
    )
    NotificationDigestRun.objects.filter(
        user_id=user_id, event_type=event_type, period_start=period_start
    ).update(notification_count=count)
    return count


def _load_user(user_id: Any) -> Any:
    from django.contrib.auth import get_user_model

    return get_user_model().objects.filter(pk=user_id).first()


def purge_old_digest_runs(older_than_days: int = 90) -> int:
    """Delete digest ledger rows older than *older_than_days*. Returns rows deleted.

    90 days rather than the 7-day per-request outbox convention: this ledger's job
    is to remember a *weekly* send, so a 7-day window would forget a fortnight-old
    run it must not repeat.
    """
    cutoff = timezone.now() - datetime.timedelta(days=older_than_days)
    deleted, _ = NotificationDigestRun.objects.filter(created_at__lt=cutoff).delete()
    return deleted


def digest_event_types() -> Iterable[str]:
    """The event types this module sends — used by tests and the settings surface."""
    return DIGEST_EVENT_TYPES
