"""The draft exclusion list (#2962).

A draft is a plan nobody has agreed to yet. It is fully writable — that is the
difference from ``is_archived`` — but it must not appear in anything that
*aggregates*, because a half-built plan inside a rollup makes that rollup a
guess with a chart around it.

**One module, not N filters.** The exclusion has to hold across program rollup,
portfolio health, search and notifications, and those live in different modules
maintained at different times. A `.exclude(lifecycle=DRAFT)` written out per
surface is a place to forget it per surface; this module is one place to get it
right and one place to grep for.

It says *module* rather than *helper* because #3128 found the single-helper
framing was itself part of why the list leaked. :func:`visible_projects` takes a
``Project`` queryset, and half the surfaces that must honor the exclusion never
build one — omni-search and the cross-project dependency picker filter ``Task``
rows, and the Programs directory counts projects inside a ``Count(filter=...)``
annotation on ``Program``. Faced with a helper that did not fit, those sites
wrote nothing at all. So there are three shapes of the same predicate —
:func:`visible_projects`, :func:`exclude_draft_projects`, :func:`not_draft_q` —
and the rule is: **no surface writes its own draft-exclusion predicate.** If a
new one fits none of the three, add a fourth here rather than inlining it there.

Be exact about what that rule does and does not say, because the tempting
stronger version ("``ProjectLifecycle.DRAFT`` appears in this file and nowhere
else") is *false* and would be a trap to write down. ``commit_moment.py`` reads
it to decide whether a project is committable, and ``amend.py`` reads its
sibling ``ACTIVE`` — those are state *transitions*, which are none of this
module's business. The rule covers exclusion filters only, and nothing enforces
it mechanically today: a gate would have to tell a transition check apart from
an exclusion filter, which is not a grep. Treat it as a convention this module
argues for, not a guarantee something checks (#3128).

**The MCP read surface is deliberately NOT on this list**, which is a correction
to the design rather than an omission. Hiding a project from an agent's reads is
indistinguishable from a 404 or a token-scope miss: the agent cannot tell "not
committed yet" from "does not exist" and has no way to debug the difference.
``lifecycle`` is returned as an ordinary field instead, so a client can filter on
a stated fact. Filtering is something a caller can do; recovering from silence is
not.

**Two more surfaces are deliberately NOT on this list** (#3144). The #3128 audit
found both leaking and left both, because filtering them is a decision about
people and about their own files rather than a correctness fix about plans. Both
decisions are KEEP, and the reasoning is recorded here so the next audit reads it
instead of re-deriving it.

*The mention fan-out* (``access.groups._program_membership_base_qs``). The
strongest reason is structural rather than a values call. That queryset is the
one base **all four** ``@program-*`` keys narrow, and its own docstring forbids a
per-key filter. So a draft exclusion has no legal placement: written where it
belongs it also drops the draft's Admin out of ``@program-pms`` and its Scheduler
out of ``@program-schedulers`` — the people *authoring the draft*, cut out of
program-wide coordination — and written per key it breaks the invariant the
helper was extracted to hold. The values argument agrees: draft-ness is a
property of the plan someone was added to, not of their standing in the program,
and the failure mode of dropping them is silence neither they nor the sender can
see, exactly as for the MCP surface above. Two further consequences, both
deliberate:

* ``@program-stakeholders`` has a second arm. ``ExternalStakeholder`` is
  program-owned with **no project FK**, so no project-level narrowing can reach
  it. Excluding the internal arm would report ``viewer_member_count: 0`` beside a
  non-zero external count on a program whose projects are all drafts — an
  incoherence between the arms that does not exist today.
* A mention *written in* a draft project still fans out program-wide. That is the
  other leak direction, and it is kept too: #3128's three notification sites were
  unattended machine sweeps over a project population, whereas a PM typing
  ``@program-stakeholders`` into a draft is deliberately asking for review, which
  is what a draft is for.

The cost of keeping, named so a later report traces here: draft memberships
consume ``@program-all``'s ``ALL_GROUP_HARD_CAP`` slots, so enough drafts can trip
``GroupTooLargeError`` on the strength of plans nobody committed to. Accepted —
the cap is a blast-radius guard over real people, who are genuinely reached.

Keeping also holds ``count_program_stakeholder_reach`` in lockstep with the
resolver (ADR-0697) for free: the count and the fan-out cannot drift if neither
moves. The program-settings docs say the alias reaches "members holding the Viewer
role on any project inside the program", which stays true under KEEP; that
sentence becomes wrong, and must gain the gap, only if this decision flips.

*The cross-project asset feeds* (``projects.asset_feed``, behind
``GET /programs/{pk}/assets/`` and ``GET /assets/``) are the member's own browse
list, which this module exempts, at two scopes — the workspace view is literally
the program view with the ``project__program=`` clause dropped, and both narrow to
the caller's own ``ProjectMembership``. ``?q=`` makes them look like the
omni-search palette this list does name, but the line under omni-search and the
dependency picker is that a returned row is *acted on across a boundary*: the
palette navigates into a project, the picker mints an edge that moves a real
project's dates. Nothing downstream of an asset row changes a schedule, and the
feed emits no count, health band or ranking that an exclusion would make truer.
What exclusion would produce instead is a visibility discontinuity at the commit
moment: a file you attached to your own draft disappears from the surface built to
find it and returns when somebody else commits the plan.

``GET /assets/`` is additionally a declared MCP read surface
(``McpReadableViewMixin``), which the paragraph above exempts outright; note this
covers only the workspace tier — ``ProgramAssetsView`` is not MCP-readable, and
the browse-list argument is what carries it. An operator who wants a project out
of an agent's index already has ``mcp_settings.mcp_excluded_project_ids``, a
stated and auditable lever orthogonal to lifecycle.
"""

from __future__ import annotations

from typing import Any, TypeVar

from django.db.models import Model, Q, QuerySet

from .models import Project, ProjectLifecycle

_M = TypeVar("_M", bound=Model)


def visible_projects(qs: QuerySet[Project]) -> QuerySet[Project]:
    """Drop drafts from an aggregate.

    Apply to any queryset feeding a rollup, a health figure, a search result or an
    **unattended** notification fan-out over a project population. Do **not** apply
    it to a direct read of one project by id, to the project list a member browses,
    to the MCP read surface, or to a mention resolver, where a human named the
    audience at write time (#3144) — a draft is not a secret, it is merely
    uncommitted.
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

    ``path`` must be **single-valued** (a chain of forward FKs / one-to-ones), and
    that is enforced below rather than documented and hoped for. On a single-valued
    path Django appends a bare column predicate to a join it already has. On a
    multi-valued one (``Program.projects``) the same call compiles to a correlated
    ``NOT EXISTS`` and, far worse, silently *inverts the question*: it drops every
    row whose related set contains **any** draft, rather than dropping draft rows.
    That is a wrong answer, not a slow one, and nothing downstream would show it —
    so it fails loudly here instead. For an aggregate over a multi-valued relation
    use :func:`not_draft_q` inside the aggregate's own ``filter=``.

    Args:
        qs: Any queryset with a single-valued relation reaching ``Project``.
        path: The ORM lookup path from ``qs``'s model to that ``Project``
            (``"project"`` for ``Task``, ``"task__project"`` for a task's children).

    Raises:
        ValueError: If ``path`` traverses a multi-valued relation.
    """
    model: Any = qs.model
    for part in path.split("__"):
        field = model._meta.get_field(part)
        if field.many_to_many or field.one_to_many:
            raise ValueError(
                f"exclude_draft_projects: path {path!r} traverses the multi-valued "
                f"relation {part!r} on {model.__name__}. That would drop every row "
                "whose related set contains ANY draft, not the draft rows — use "
                "not_draft_q() inside the aggregate's filter= instead."
            )
        model = field.related_model
    lookup: dict[str, Any] = {f"{path}__lifecycle": ProjectLifecycle.DRAFT}
    return qs.exclude(**lookup)


def not_draft_q(path: str = "") -> Q:
    """The same exclusion as a ``Q``, for an aggregate's ``filter=`` argument.

    ``Count(..., filter=...)`` takes a ``Q``, not a queryset, so the one place
    that counts projects inside an annotation on ``Program`` cannot call either
    helper above. It gets this instead of hand-writing the predicate, so the
    exclusion still has one definition rather than one per surface.

    Args:
        path: The ORM lookup path to the ``Project``, or ``""`` when the
            queryset's own model is ``Project`` (``"projects"`` from ``Program``).
    """
    field = f"{path}__lifecycle" if path else "lifecycle"
    return ~Q(**{field: ProjectLifecycle.DRAFT})


def is_draft(project: Project) -> bool:
    """True when nobody has committed to this plan yet."""
    return project.lifecycle == ProjectLifecycle.DRAFT
