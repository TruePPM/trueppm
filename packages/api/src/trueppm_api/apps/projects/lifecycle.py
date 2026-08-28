"""The draft exclusion list (#2962).

A draft is a plan nobody has agreed to yet. It is fully writable — that is the
difference from ``is_archived`` — but it must not appear in anything that
*aggregates*, because a half-built plan inside a rollup makes that rollup a
guess with a chart around it.

**One helper, not four filters.** The exclusion has to hold across program
rollup, portfolio health, search and notifications, and those live in different
modules maintained at different times. A `.exclude(lifecycle=DRAFT)` written out
four times is four places to forget it; :func:`visible_projects` is one place to
get it right and one place to grep for.

**The MCP read surface is deliberately NOT on this list**, which is a correction
to the design rather than an omission. Hiding a project from an agent's reads is
indistinguishable from a 404 or a token-scope miss: the agent cannot tell "not
committed yet" from "does not exist" and has no way to debug the difference.
``lifecycle`` is returned as an ordinary field instead, so a client can filter on
a stated fact. Filtering is something a caller can do; recovering from silence is
not.
"""

from __future__ import annotations

from typing import Any, TypeVar

from django.db.models import Model, Q, QuerySet

from .models import Project, ProjectLifecycle

_M = TypeVar("_M", bound=Model)


def visible_projects(qs: QuerySet[Project]) -> QuerySet[Project]:
    """Drop drafts from an aggregate.

    Apply to any queryset feeding a rollup, a health figure, a search result or
    a notification fan-out. Do **not** apply it to a direct read of one project
    by id, to the project list a member browses, or to the MCP read surface —
    a draft is not a secret, it is merely uncommitted.
    """
    return qs.exclude(lifecycle=ProjectLifecycle.DRAFT)


def exclude_draft_projects(qs: QuerySet[_M], path: str = "project") -> QuerySet[_M]:
    """Drop rows whose owning project is a draft, from a *non*-Project queryset.

    The same exclusion as :func:`visible_projects`, reached across a relation.
    Two of the four surfaces the exclusion list names — omni-search and the
    cross-project dependency picker — never build a ``Project`` queryset at all;
    they filter ``Task`` rows by their project. Without this, those sites would
    each have to hand-write ``exclude(project__lifecycle="draft")``, which is
    exactly the "four places to forget it" the module docstring rejects.

    Args:
        qs: Any queryset with a relation reaching ``Project``.
        path: The ORM lookup path from ``qs``'s model to that ``Project``
            (``"project"`` for ``Task``, ``"task__project"`` and so on).
    """
    lookup: dict[str, Any] = {f"{path}__lifecycle": ProjectLifecycle.DRAFT}
    return qs.exclude(**lookup)


def not_draft_q(path: str = "") -> Q:
    """The same exclusion as a ``Q``, for an aggregate's ``filter=`` argument.

    ``Count(..., filter=...)`` takes a ``Q``, not a queryset, so the one place
    that counts projects inside an annotation on ``Program`` cannot call either
    helper above. It gets this instead of hand-writing the predicate, so
    ``ProjectLifecycle.DRAFT`` still appears exactly once in this module and
    nowhere else.

    Args:
        path: The ORM lookup path to the ``Project``, or ``""`` when the
            queryset's own model is ``Project`` (``"projects"`` from ``Program``).
    """
    field = f"{path}__lifecycle" if path else "lifecycle"
    return ~Q(**{field: ProjectLifecycle.DRAFT})


def is_draft(project: Project) -> bool:
    """True when nobody has committed to this plan yet."""
    return project.lifecycle == ProjectLifecycle.DRAFT
