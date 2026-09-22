"""Validate a TruePPM JSON seed document (ADR-0109, issue #614).

``validate_seed`` is a pure, side-effect-free function: it checks a parsed
payload against the bundled JSON Schema (draft 2020-12) and then runs a
referential-integrity pass that JSON Schema cannot express — duplicate
file-local slugs and dangling cross-references (an assignee that names no
account, a dependency edge to a task that does not exist, and so on).

Both the structural and referential phases collect *all* failures before
raising, so a seed author fixing a hand-written file sees every problem at
once rather than one-per-run. Every error is anchored to a JSON path so the
offending location is obvious.

Two entry points share one implementation:

``inspect_seed``
    Pure and total — never raises for a bad document. Returns a
    :class:`SeedReport` carrying every diagnostic plus what the file *claims*
    to be (version, program slug, entity counts). This is what the dry-run
    endpoint and ``manage.py import_seed --check`` call (#2418).
``validate_seed``
    The original raise-on-invalid contract the importer depends on, now a thin
    wrapper over ``inspect_seed``. Its behavior is unchanged in the only way
    that matters: a document that failed before still fails, with at least the
    same diagnostics.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

# Schema majors this validator understands. The major component is the
# compatibility boundary: a payload whose major is unknown is rejected outright.
# v2 (ADR-0114) is an additive superset of v1 — relative dates + an events
# timeline — so both load through their own bundled schema. See ADR-0109/0114.
SUPPORTED_MAJORS = ("1", "2")

# Aggregate ceiling on materializable entities across the whole document.
# Per-array maxItems in the schema bound each collection; this bounds the
# *total* — a single import must not be able to create an unbounded number of
# rows in one transaction. Generous: the largest bundled sample is a few hundred
# entities.
MAX_SEED_NODES = 100_000

# Longest a single diagnostic may be. jsonschema renders the *whole offending
# instance* into ``ValidationError.message`` for container-level keywords, so a
# ``maxItems`` violation on ``projects`` echoes every project back at the caller
# — a 201-project document produces a 10 KB line, and a document padded to
# SEED_MAX_UPLOAD_MB produces megabytes, in a 400 whose body the caller chose
# the size of (#2615). The path prefix and the keyword both survive truncation,
# which is the part a caller can act on.
MAX_SEED_ERROR_CHARS = 300

_SCHEMAS_DIR = Path(__file__).resolve().parent.parent / "schemas"
_SCHEMA_PATH_BY_MAJOR = {
    "1": _SCHEMAS_DIR / "seed_v1.json",
    "2": _SCHEMAS_DIR / "seed_v2.json",
}


class SeedValidationError(ValueError):
    """Raised when a seed document fails structural or referential validation.

    ``errors`` holds every individual problem (JSON-path anchored) so callers —
    the import endpoint (#615) in particular — can surface a complete report
    rather than a single message.
    """

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        count = len(errors)
        noun = "error" if count == 1 else "errors"
        super().__init__(f"Seed validation failed with {count} {noun}:\n" + "\n".join(errors))


@lru_cache(maxsize=len(_SCHEMA_PATH_BY_MAJOR))
def _validator(major: str) -> Draft202012Validator:
    """Build (once per major) the schema validator with format checking on.

    ``format`` is an annotation in JSON Schema by default; we opt into checking
    it so ``"2026-13-40"`` in a ``planned_start`` is caught here rather than
    blowing up later at ``date.fromisoformat`` time during import.
    """
    schema = json.loads(_SCHEMA_PATH_BY_MAJOR[major].read_text(encoding="utf-8"))
    return Draft202012Validator(schema, format_checker=FormatChecker())


def _json_path(absolute_path: Any) -> str:
    """Render a jsonschema error path as ``$.projects[0].tasks[2].wbs_path``."""
    out = "$"
    for part in absolute_path:
        out += f"[{part}]" if isinstance(part, int) else f".{part}"
    return out


@dataclass(frozen=True)
class SeedReport:
    """The full result of inspecting a seed document, without importing it.

    ``errors`` is the same JSON-path-anchored list :class:`SeedValidationError`
    carries. The remaining fields echo back what the *document claims to be* so
    an operator running a dry run can confirm they grabbed the right file
    before pointing a wipe-then-recreate import at a live program slug
    (ADR-0109). They are read defensively: a malformed document still produces
    a report, with ``None``/``0`` where a claim could not be read.
    """

    valid: bool
    errors: list[str]
    schema_version: str | None
    program_slug: str | None
    program_name: str | None
    project_count: int
    task_count: int
    resource_count: int


def inspect_seed(payload: Any, *, allow_sample_sections: bool = False) -> SeedReport:
    """Inspect a parsed seed document and report every problem found.

    Total by construction — a document this rejects still yields a report
    rather than an exception, because the dry-run caller needs the diagnostics
    precisely when the document is bad (#2418).

    Args:
        payload: the already-parsed JSON, not a raw string. Any type is
            accepted; a non-object is itself reported as a diagnostic.
        allow_sample_sections: accept the sections that create audit evidence or
            credentials (see :func:`_sample_only_errors`). Only the bundled-sample
            path may pass ``True``; the default rejects them, so a new caller is
            fail-closed.

    Returns:
        A :class:`SeedReport` whose ``valid`` is ``True`` only when ``errors``
        is empty.
    """
    if not isinstance(payload, dict):
        return SeedReport(
            valid=False,
            errors=["$: seed document must be a JSON object"],
            schema_version=None,
            program_slug=None,
            program_name=None,
            project_count=0,
            task_count=0,
            resource_count=0,
        )

    errors = _document_errors(payload)
    if not allow_sample_sections:
        errors = _sample_only_errors(payload) + errors
    return SeedReport(
        valid=not errors,
        errors=errors,
        schema_version=payload.get("schema_version")
        if isinstance(payload.get("schema_version"), str)
        else None,
        **_claimed_shape(payload),
    )


def _claimed_shape(payload: dict[str, Any]) -> dict[str, Any]:
    """Read the program identity + entity counts a document claims to carry.

    Every access is defensive: this runs on documents that have already failed
    validation, where ``program`` may be absent or the wrong type entirely.
    """
    program = payload.get("program")
    program = program if isinstance(program, dict) else {}
    projects = payload.get("projects")
    projects = projects if isinstance(projects, list) else []
    resources = payload.get("resources")
    resources = resources if isinstance(resources, list) else []

    task_count = 0
    for project in projects:
        if isinstance(project, dict) and isinstance(project.get("tasks"), list):
            task_count += len(project["tasks"])

    return {
        "program_slug": program.get("slug") if isinstance(program.get("slug"), str) else None,
        "program_name": program.get("name") if isinstance(program.get("name"), str) else None,
        "project_count": len(projects),
        "task_count": task_count,
        "resource_count": len(resources),
    }


def _document_errors(payload: dict[str, Any]) -> list[str]:
    """Collect every diagnostic for an object-shaped document.

    Version handling is the one place the passes are *not* purely additive, and
    the two failure modes are deliberately asymmetric (#2418):

    - **Missing** ``schema_version`` — the version is reported, and the
      structural pass still runs against the newest supported schema. v2 is an
      additive superset of v1 (ADR-0114), so a v1-shaped document validated
      against v2 still passes structurally; running it is what lets a
      version-less file report its *other* twenty problems in the same pass
      instead of hiding them behind one line. The version is injected into a
      shallow copy for that pass only — both bundled schemas list
      ``schema_version`` as required, so without the injection the schema would
      re-report the same problem in less specific language.
    - **Unsupported** major — reported, and the structural pass is *skipped*.
      Here there is no defensible schema to substitute: checking a 3.x document
      against the v2 schema would bury the one diagnostic that matters under a
      wall of misleading ones.
    """
    version = payload.get("schema_version")
    if version is None:
        latest = SUPPORTED_MAJORS[-1]
        return [
            "$.schema_version: required and missing",
            *_schema_errors({**payload, "schema_version": f"{latest}.0"}, latest),
        ]

    major = version.split(".")[0] if isinstance(version, str) else None
    if major not in _SCHEMA_PATH_BY_MAJOR:
        supported = ", ".join(f"{m}.x" for m in SUPPORTED_MAJORS)
        return [
            f"$.schema_version: unsupported version {version!r}; this build supports {supported}"
        ]

    return _schema_errors(payload, major)


def _bounded_message(message: str) -> str:
    """Clamp one jsonschema diagnostic to roughly ``MAX_SEED_ERROR_CHARS``.

    Truncated in the **middle**, not at the end. jsonschema renders these as
    ``<instance> is too long`` / ``<instance> has too many items`` — the
    offending value first and the *verdict* last — so clipping the tail keeps
    the megabytes and throws away the only part that says what is wrong. Middle
    truncation keeps both ends: enough of the value to recognize it, and the
    phrase naming the violated keyword.
    """
    if len(message) <= MAX_SEED_ERROR_CHARS:
        return message
    head = MAX_SEED_ERROR_CHARS * 2 // 3
    tail = MAX_SEED_ERROR_CHARS - head
    return f"{message[:head]} …(truncated)… {message[-tail:]}"


def _schema_errors(payload: dict[str, Any], major: str) -> list[str]:
    """Run the structural pass, then the semantic passes it is a precondition for."""
    errors: list[str] = [
        f"{_json_path(e.absolute_path)}: {_bounded_message(e.message)}"
        for e in sorted(_validator(major).iter_errors(payload), key=lambda e: list(e.absolute_path))
    ]

    # Referential integrity only runs when the document is structurally sound —
    # the cross-reference walk assumes well-typed slugs and arrays.
    if not errors:
        errors.extend(_referential_errors(payload))
        errors.extend(_node_budget_errors(payload))
        if major == "2":
            errors.extend(_event_errors(payload))
            errors.extend(_v21_event_errors(payload))

    return errors


def validate_seed(payload: Any, *, allow_sample_sections: bool = False) -> None:
    """Validate a parsed seed document. Returns ``None`` on success.

    Args:
        payload: the already-parsed JSON (a ``dict``), not a raw string.
        allow_sample_sections: see :func:`inspect_seed`. Default ``False``.

    Raises:
        SeedValidationError: with one message per problem found.
    """
    report = inspect_seed(payload, allow_sample_sections=allow_sample_sections)
    if not report.valid:
        raise SeedValidationError(report.errors)


# Restated, not imported: this module must stay importable without Django (the
# fixture build scripts in scripts/seeds call validate_seed with no settings), so it
# cannot reach projects.models. test_seed_v21 pins this copy to
# ``RESERVED_SCRUM_CEREMONY_NAMES``, and the schema's reaction ``emoji`` enum to
# ``ALLOWED_REACTION_EMOJI``, so neither can drift silently.
RESERVED_CEREMONY_NAMES = frozenset(
    {
        "sprint planning",
        "sprint review",
        "sprint retrospective",
        "retrospective",
        "retro",
        "daily scrum",
        "standup",
        "daily standup",
        "scrum of scrums",
    }
)


def _sample_only_errors(payload: Any) -> list[str]:
    """Reject the sections only a bundled sample may carry (#3603).

    ``agent_actions`` writes rows into the instance's hash-chained audit log and
    ``share_links`` mints public bearer credentials. A user who can import a file
    must be able to do neither: the first would forge audit history, the second
    would publish a board. Rejected rather than dropped, because a dropped section
    reports success for a document that did not import as written.

    Reads defensively — this runs even on a document that fails the schema, so the
    one diagnostic that explains *why* the section is refused is never hidden.
    """
    if not isinstance(payload, dict):
        return []
    errors: list[str] = []
    program = payload.get("program")
    if isinstance(program, dict) and "agent_actions" in program:
        errors.append(
            "$.program.agent_actions: only bundled sample programs may carry agent "
            "actions — audit evidence cannot be imported from a file"
        )
    projects = payload.get("projects")
    if isinstance(projects, list):
        for i, project in enumerate(projects):
            if isinstance(project, dict) and "share_links" in project:
                errors.append(
                    f"$.projects[{i}].share_links: only bundled sample programs may carry "
                    "share links — a public access credential cannot be imported from a file"
                )
    return errors


def _v21_reference_errors(payload: dict[str, Any], ctx: _RefContext, errors: list[str]) -> None:
    """Cross-references for the v2.1 program/project/task sections (#3603)."""
    program = payload.get("program", {})
    _v21_depth_errors(payload, ctx, errors)
    _check_backlog_items(program.get("backlog_items", []), ctx, errors)
    _check_ceremonies(program.get("ceremonies", []), errors)
    _check_agent_actions(program.get("agent_actions", []), ctx, errors)
    for i, project in enumerate(payload.get("projects", [])):
        pbase = f"$.projects[{i}]"
        for k, link in enumerate(project.get("share_links", [])):
            _check_ref(
                link.get("created_by"),
                ctx.account_slugs,
                f"{pbase}.share_links[{k}].created_by",
                "account",
                errors,
            )
        for j, task in enumerate(project.get("tasks", [])):
            for k, criterion in enumerate(task.get("acceptance_criteria", [])):
                _check_ref(
                    criterion.get("met_by"),
                    ctx.account_slugs,
                    f"{pbase}.tasks[{j}].acceptance_criteria[{k}].met_by",
                    "account",
                    errors,
                )


_WEEKDAY_BITS = {"mon": 1, "tue": 2, "wed": 4, "thu": 8, "fri": 16, "sat": 32, "sun": 64}


def _v21_depth_errors(payload: dict[str, Any], ctx: _RefContext, errors: list[str]) -> None:
    """Team facets, drawer subtasks and recurrence rules (v2.1, #3498).

    Mirrors the rules the API enforces on the same writes, so a seed cannot express a
    team, a subtask tree or a recurrence the product would refuse to create.
    """
    accounts_with_role = {
        a.get("slug", "") for a in payload.get("accounts", []) if a.get("role") is not None
    }
    for i, project in enumerate(payload.get("projects", [])):
        base = f"$.projects[{i}]"
        if "members" in project:
            members = {m.get("account", "") for m in project.get("members", [])}
        else:
            members = accounts_with_role
        _check_team(project.get("team"), f"{base}.team", members, ctx, errors)
        tasks = project.get("tasks", [])
        by_wbs = {t.get("wbs_path"): t for t in tasks}
        for j, task in enumerate(tasks):
            tpath = f"{base}.tasks[{j}]"
            if task.get("is_subtask"):
                _check_subtask(task, by_wbs, tpath, errors)
            if "recurrence" in task:
                _check_recurrence(task, tpath, errors)


def _check_team(
    team: dict[str, Any] | None,
    base: str,
    project_members: set[str],
    ctx: _RefContext,
    errors: list[str],
) -> None:
    """A facet goes to a project member, and each facet has at most one holder.

    ``TeamMembership`` mirrors ``ProjectMembership`` onto the default team, so a facet
    on a non-member has no row to land on. The one-holder rule is the soft singleton
    the team service enforces on reassignment.
    """
    if not team:
        return
    seen: set[str] = set()
    holders = {"scrum_master": 0, "product_owner": 0}
    for k, member in enumerate(team.get("members", [])):
        mpath = f"{base}.members[{k}]"
        account = member.get("account", "")
        _check_ref(account, ctx.account_slugs, f"{mpath}.account", "account", errors)
        if account in ctx.account_slugs and account not in project_members:
            errors.append(f"{mpath}.account: {account!r} is not a member of this project")
        if account in seen:
            errors.append(f"{mpath}.account: {account!r} is listed twice")
        seen.add(account)
        for facet in holders:
            if member.get(facet):
                holders[facet] += 1
    for facet, count in holders.items():
        if count > 1:
            errors.append(f"{base}.members: a team has at most one {facet}, found {count}")


def _check_subtask(
    task: dict[str, Any], by_wbs: dict[Any, dict[str, Any]], tpath: str, errors: list[str]
) -> None:
    """Drawer subtasks are depth-1 leaves under a decomposable task (ADR-0060, #1750)."""
    wbs = str(task.get("wbs_path", ""))
    parent_path, _, _ = wbs.rpartition(".")
    parent = by_wbs.get(parent_path) if parent_path else None
    if parent is None:
        where = parent_path or "?"
        errors.append(f"{tpath}.is_subtask: a subtask needs a parent task at {where!r}")
        return
    if parent.get("is_milestone"):
        errors.append(f"{tpath}.is_subtask: a milestone cannot hold subtasks")
    if parent.get("is_subtask"):
        errors.append(f"{tpath}.is_subtask: a subtask cannot hold subtasks")
    prefix = f"{parent_path}."
    for path, sibling in by_wbs.items():
        child = str(path)
        is_direct_child = child.startswith(prefix) and "." not in child[len(prefix) :]
        if is_direct_child and not sibling.get("is_subtask"):
            errors.append(
                f"{tpath}.is_subtask: {parent_path!r} groups structural work, and a phase "
                "cannot also hold subtasks"
            )
            break
    if any(str(path).startswith(f"{wbs}.") for path in by_wbs):
        errors.append(f"{tpath}.is_subtask: a subtask cannot have children")


def _check_recurrence(task: dict[str, Any], tpath: str, errors: list[str]) -> None:
    """Mirror ``TaskRecurrenceRule.clean()`` plus the template constraints."""
    rule = task.get("recurrence") or {}
    rpath = f"{tpath}.recurrence"
    frequency = rule.get("frequency")
    if frequency == "WEEKLY" and not rule.get("weekdays"):
        errors.append(f"{rpath}.weekdays: weekly recurrence requires at least one weekday")
    if frequency == "MONTHLY" and rule.get("day_of_month") is None:
        errors.append(f"{rpath}.day_of_month: monthly recurrence requires a day of month")
    if "end_date" in rule and "end_count" in rule:
        errors.append(f"{rpath}: give end_date or end_count, not both")
    if task.get("is_milestone") or task.get("is_subtask"):
        errors.append(f"{rpath}: a milestone or a subtask cannot be a recurrence template")


def _check_backlog_items(items: list[dict[str, Any]], ctx: _RefContext, errors: list[str]) -> None:
    """A pulled item names exactly the one task it became (``pulled_task`` is 1:1)."""
    _collect_slugs(items, "$.program.backlog_items", errors)
    pulled: set[str] = set()
    for i, item in enumerate(items):
        base = f"$.program.backlog_items[{i}]"
        for key in ("pulled_by", "created_by"):
            _check_ref(item.get(key), ctx.account_slugs, f"{base}.{key}", "account", errors)
        status = item.get("status", "proposed")
        target = item.get("pulled_to")
        if target is None:
            if status == "pulled":
                errors.append(f"{base}.pulled_to: a pulled item must name the task it became")
            continue
        if status != "pulled":
            errors.append(
                f"{base}.pulled_to: only a pulled item may name a task (status {status!r})"
            )
        _check_task_ref(target, "", ctx.task_index, f"{base}.pulled_to", errors)
        if target in pulled:
            errors.append(f"{base}.pulled_to: task {target!r} is already another item's pull")
        pulled.add(target)


def _check_ceremonies(items: list[dict[str, Any]], errors: list[str]) -> None:
    """Mirror ``CeremonyTemplateSerializer``: no sprint events, unique names, a clock anchor."""
    seen: set[str] = set()
    for i, ceremony in enumerate(items):
        base = f"$.program.ceremonies[{i}]"
        name = str(ceremony.get("name", "")).strip().casefold()
        if name in RESERVED_CEREMONY_NAMES:
            errors.append(
                f"{base}.name: {ceremony.get('name')!r} is a team-level sprint event, "
                "not a program ceremony (ADR-0079)"
            )
        if name in seen:
            errors.append(f"{base}.name: duplicate ceremony name {ceremony.get('name')!r}")
        seen.add(name)
        cadence = ceremony.get("cadence_type")
        if cadence != "on_milestone":
            for key in ("cadence_day", "cadence_time"):
                if not ceremony.get(key):
                    errors.append(f"{base}.{key}: required for a {cadence} cadence")


def _check_agent_actions(items: list[dict[str, Any]], ctx: _RefContext, errors: list[str]) -> None:
    """Agent actions resolve to real accounts/projects/tasks; only refusals carry a refusal."""
    for i, action in enumerate(items):
        base = f"$.program.agent_actions[{i}]"
        _check_ref(
            action.get("principal"), ctx.account_slugs, f"{base}.principal", "account", errors
        )
        _check_ref(action.get("project"), ctx.project_slugs, f"{base}.project", "project", errors)
        _check_task_ref(action.get("object"), "", ctx.task_index, f"{base}.object", errors)
        if action.get("verdict") != "refused":
            for key in ("refusal_reason", "refusal_constraint"):
                if key in action:
                    errors.append(f"{base}.{key}: only a refused action carries a refusal")


_ACTION_TIME_LOG = "time.log"
_ACTION_TASK_REACT = "task.react"
_ACTION_TASK_ACK = "task.ack"
_ACTION_TASK_COMMENT = "task.comment"

# Actions whose attribution is the whole fact: a time entry, a reaction or an
# acknowledgement by nobody in particular is not something to fall back to the
# importing owner for, so each must name its actor.
_ACTOR_REQUIRED = frozenset({_ACTION_TIME_LOG, _ACTION_TASK_REACT, _ACTION_TASK_ACK})


def _index_comment_threads(
    events: list[dict[str, Any]], errors: list[str]
) -> tuple[dict[str, str], set[str]]:
    """Top-level comment slug -> the task target it was posted on, so a reply can be
    held to the same task. Replies keep only their slug: nothing may answer them.
    Appends a duplicate-slug error to `errors` in place rather than returning one.
    """
    roots: dict[str, str] = {}
    replies: set[str] = set()
    for i, event in enumerate(events):
        if event.get("action") != _ACTION_TASK_COMMENT or "slug" not in event:
            continue
        slug = event["slug"]
        if slug in roots or slug in replies:
            errors.append(f"$.events[{i}].slug: duplicate comment slug {slug!r}")
            continue
        if event.get("reply_to"):
            replies.add(slug)
        else:
            roots[slug] = str(event.get("target", ""))
    return roots, replies


def _check_event(
    event: dict[str, Any],
    i: int,
    roots: dict[str, str],
    replies: set[str],
    criteria_count: dict[tuple[str, Any], int],
    errors: list[str],
) -> None:
    base = f"$.events[{i}]"
    action = event.get("action")
    _check_reply_to(event, action, base, roots, replies, errors)
    if action in (_ACTION_TASK_REACT, _ACTION_TASK_ACK):
        _, _, slug = str(event.get("target", "")).partition(":")
        if slug and slug not in roots and slug not in replies:
            errors.append(f"{base}.target: no comment with slug {slug!r}")
    if action in _ACTOR_REQUIRED and not event.get("actor"):
        errors.append(f"{base}.actor: {action} must name the account it is attributed to")
    if action == _ACTION_TASK_REACT and "emoji" not in event:
        errors.append(f"{base}.emoji: task.react requires an emoji")
    if action == "task.note" and not event.get("body"):
        errors.append(f"{base}.body: task.note requires a body")
    if action == _ACTION_TIME_LOG:
        _check_time_log(event, base, errors)
    if "criterion" in event:
        _check_criterion(event, action, base, criteria_count, errors)


def _v21_event_errors(payload: dict[str, Any]) -> list[str]:
    """Comment threading, comment-targeted beats, criterion ticks and time beats (#3603)."""
    errors: list[str] = []
    events = payload.get("events", [])
    roots, replies = _index_comment_threads(events, errors)

    criteria_count = {
        (project.get("slug", ""), task.get("wbs_path")): len(task.get("acceptance_criteria", []))
        for project in payload.get("projects", [])
        for task in project.get("tasks", [])
    }

    for i, event in enumerate(events):
        _check_event(event, i, roots, replies, criteria_count, errors)
    return errors


def _check_reply_to(
    event: dict[str, Any],
    action: Any,
    base: str,
    roots: dict[str, str],
    replies: set[str],
    errors: list[str],
) -> None:
    """Replies are one level deep and stay on their thread's task, as the API enforces."""
    reply_to = event.get("reply_to")
    if reply_to is None:
        return
    if action != _ACTION_TASK_COMMENT:
        errors.append(f"{base}.reply_to: only task.comment may reply to a comment")
    elif reply_to in replies:
        errors.append(
            f"{base}.reply_to: {reply_to!r} is itself a reply; replies are one level deep"
        )
    elif reply_to not in roots:
        errors.append(f"{base}.reply_to: no comment with slug {reply_to!r}")
    elif roots[reply_to] != event.get("target"):
        errors.append(
            f"{base}.reply_to: comment {reply_to!r} is on {roots[reply_to]!r}, "
            "and a reply must be posted on the same task"
        )


def _check_time_log(event: dict[str, Any], base: str, errors: list[str]) -> None:
    """Logged time needs minutes and cannot be dated after the anchor ("today")."""
    if "minutes" not in event:
        errors.append(f"{base}.minutes: time.log requires minutes")
    at = str(event.get("at", ""))
    if at.startswith("A+"):
        digits = at[2:].split("T")[0]
        if digits.isdigit() and int(digits) > 0:
            errors.append(
                f"{base}.at: time.log cannot be forward-dated ({at!r} is after the anchor)"
            )


def _check_criterion(
    event: dict[str, Any],
    action: Any,
    base: str,
    criteria_count: dict[tuple[str, Any], int],
    errors: list[str],
) -> None:
    """A ``criterion`` index must address a criterion the target task declares."""
    if action != "task.ac_met":
        errors.append(f"{base}.criterion: only task.ac_met may tick a criterion")
        return
    _, _, ref = str(event.get("target", "")).partition(":")
    project_slug, _, wbs = ref.partition(":")
    count = criteria_count.get((project_slug, wbs))
    if count is not None and event["criterion"] >= count:
        errors.append(
            f"{base}.criterion: task {ref!r} declares {count} acceptance criteria, "
            f"so index {event['criterion']} does not exist"
        )


# Which target kind each event action addresses. Every replayed action carries a
# target; an unknown action (should never reach here — the schema enum gates it)
# is treated as target-optional so validation degrades gracefully.
_EVENT_TARGET_KIND = {
    "task.note": "task",
    _ACTION_TIME_LOG: "task",
    # A reaction/acknowledgement lands on a comment, addressed by the slug a
    # task.comment beat declared. Resolution is checked in _v21_event_errors.
    _ACTION_TASK_REACT: "comment",
    _ACTION_TASK_ACK: "comment",
    "task.status": "task",
    "task.assign": "task",
    "task.estimate": "task",
    "task.points": "task",
    _ACTION_TASK_COMMENT: "task",
    "task.ac_met": "task",
    "task.block": "task",
    "task.unblock": "task",
    "sprint.activate": "sprint",
    "sprint.close": "sprint",
    # Scope inject/resolve target the task being injected; its ACTIVE sprint is
    # derived from task.sprint, matching record_sprint_scope_change(task, sprint).
    # A re-imported export can name a task that has since left the sprint (a
    # close carried it to the backlog), so replay falls back to the sprint
    # running at the beat's own instant — see replay._injected_sprint (#3488).
    "sprint.scope_inject": "task",
    "sprint.scope_resolve": "task",
    "baseline.capture": "project",
    "risk.status": "risk",
    "risk.note": "risk",
    # retro.action creates an action item on the sprint's retro; retro.promote
    # promotes one (matched by `body`) to a backlog task. Both are per-sprint —
    # SprintRetro is 1:1 with Sprint — so the target is the sprint (ADR-0114 §7).
    "retro.action": "sprint",
    "retro.promote": "sprint",
}


def _event_errors(payload: dict[str, Any]) -> list[str]:
    """Validate v2 event actor + target references against the document (ADR-0114).

    Structural shape is already enforced by the v2 JSON Schema; this pass checks
    that every ``actor`` names an account and every ``target`` resolves to a
    task / sprint / project / risk that the same document defines.
    """
    errors: list[str] = []
    account_slugs = {a.get("slug", "") for a in payload.get("accounts", [])}
    project_slugs, task_index, sprint_index, risk_slugs = _event_indexes(payload)

    for i, event in enumerate(payload.get("events", [])):
        base = f"$.events[{i}]"
        _check_ref(event.get("actor"), account_slugs, f"{base}.actor", "account", errors)
        _check_ref(event.get("assignee"), account_slugs, f"{base}.assignee", "account", errors)
        _check_event_target_ref(
            event, base, project_slugs, task_index, sprint_index, risk_slugs, errors
        )

    return errors


def _event_indexes(
    payload: dict[str, Any],
) -> tuple[set[str], dict[str, set[str]], dict[str, set[str]], set[str]]:
    """Index project slugs, task/sprint paths, and risk slugs for event refs."""
    project_slugs: set[str] = set()
    task_index: dict[str, set[str]] = {}
    sprint_index: dict[str, set[str]] = {}
    risk_slugs: set[str] = {r.get("slug", "") for r in payload.get("risks", [])}
    for project in payload.get("projects", []):
        slug = project.get("slug", "")
        project_slugs.add(slug)
        task_index[slug] = {t.get("wbs_path") for t in project.get("tasks", [])}
        sprint_index[slug] = {s.get("slug") for s in project.get("sprints", [])}
        risk_slugs |= {r.get("slug", "") for r in project.get("risks", [])}
    return project_slugs, task_index, sprint_index, risk_slugs


def _check_event_target_ref(
    event: dict[str, Any],
    base: str,
    project_slugs: set[str],
    task_index: dict[str, set[str]],
    sprint_index: dict[str, set[str]],
    risk_slugs: set[str],
    errors: list[str],
) -> None:
    """Validate one event's ``target`` (kind/prefix/resolution) and estimate order."""
    action = event.get("action", "")
    kind = _EVENT_TARGET_KIND.get(action)
    target = event.get("target")
    if kind is None:
        return  # unknown action (schema enum should have rejected it)
    if target is None:
        errors.append(f"{base}.target: action {action!r} requires a target")
        return
    prefix, _, ref = target.partition(":")
    if prefix != kind:
        errors.append(f"{base}.target: action {action!r} expects a {kind!r} target, got {target!r}")
        return
    _check_event_target(
        kind, ref, base, project_slugs, task_index, sprint_index, risk_slugs, errors
    )
    # A task.estimate event re-points a triple mid-timeline; it must stay ordered,
    # or replay persists a triple the DB CheckConstraint rejects (#2005). Only a
    # target that passed the checks above reaches this point, matching the original
    # sequential flow (a bad target short-circuits before the estimate check).
    if action == "task.estimate":
        _check_estimate_order(event, base, errors)


def _check_event_target(
    kind: str,
    ref: str,
    base: str,
    project_slugs: set[str],
    task_index: dict[str, set[str]],
    sprint_index: dict[str, set[str]],
    risk_slugs: set[str],
    errors: list[str],
) -> None:
    """Resolve one event target ref of a given kind against the document."""
    if kind == "task":
        # Event task refs must be project-qualified (events are global/ordered,
        # there is no enclosing project to fall back to).
        if ":" not in ref:
            errors.append(f'{base}.target: task ref {ref!r} must be "<project-slug>:<wbs-path>"')
            return
        _check_task_ref(ref, "", task_index, f"{base}.target", errors)
    elif kind == "sprint":
        project_slug, _, sprint_slug = ref.partition(":")
        sprints = sprint_index.get(project_slug)
        if sprints is None:
            errors.append(f"{base}.target: no project {project_slug!r} for sprint ref {ref!r}")
        elif sprint_slug not in sprints:
            errors.append(f"{base}.target: no sprint {sprint_slug!r} in project {project_slug!r}")
    elif kind == "project" and ref not in project_slugs:
        errors.append(f"{base}.target: no project with slug {ref!r}")
    elif kind == "risk":
        if ref not in risk_slugs:
            errors.append(f"{base}.target: no risk with slug {ref!r}")


def _node_budget_errors(payload: dict[str, Any]) -> list[str]:
    """Reject documents whose total materializable entity count is excessive.

    Every collection counted here becomes rows the importer writes inside one
    transaction, so the budget has to include the *containers* too, not only
    their contents (#2615). ``projects`` and ``resources`` were previously
    omitted: a project costs ~5 statements plus a ``cascade_project_soft_delete``
    enqueue on the replace path, and each distinct resource costs ~2 round-trips
    through ``ensure_project_resource`` — both were invisible to the ceiling
    while a document of nothing but empty projects scored zero.
    """
    program = payload.get("program", {})
    total = (
        len(payload.get("projects", []))
        + len(payload.get("resources", []))
        + len(payload.get("accounts", []))
        + len(payload.get("calendars", []))
        + len(payload.get("risks", []))
        # v2.1 program sections (#3603) each materialize one row per entry.
        + len(program.get("backlog_items", []))
        + len(program.get("ceremonies", []))
        + len(program.get("agent_actions", []))
    )
    for project in payload.get("projects", []):
        total += (
            len(project.get("tasks", []))
            + len(project.get("dependencies", []))
            + len(project.get("sprints", []))
            + len(project.get("risks", []))
            + len(project.get("baselines", []))
            + len(project.get("labels", []))
            + len(project.get("share_links", []))
            + sum(len(t.get("acceptance_criteria", [])) for t in project.get("tasks", []))
            # TaskRelation rows materialize like dependencies, so they count
            # toward the per-import ceiling (ADR-0455).
            + sum(len(t.get("links", [])) for t in project.get("tasks", []))
        )
    if total > MAX_SEED_NODES:
        return [f"$: seed too large — {total} entities exceeds the {MAX_SEED_NODES} limit"]
    return []


@dataclass(frozen=True)
class _RefContext:
    """Global slug catalogs + the task index, resolved once per seed pass.

    Bundling the document-wide sets (which every per-project and per-task check
    reads but none mutates) keeps the helper signatures small — the alternative
    is threading five ``set`` parameters through every extraction.
    """

    account_slugs: set[str]
    calendar_slugs: set[str]
    resource_slugs: set[str]
    project_slugs: set[str]
    task_index: dict[str, set[str]]


def _referential_errors(payload: dict[str, Any]) -> list[str]:
    """Check duplicate slugs and dangling cross-references (ADR-0109 identity)."""
    errors: list[str] = []

    account_slugs = _collect_slugs(payload.get("accounts", []), "$.accounts", errors)
    calendar_slugs = _collect_slugs(payload.get("calendars", []), "$.calendars", errors)
    resource_slugs = _collect_slugs(payload.get("resources", []), "$.resources", errors)

    projects = payload.get("projects", [])
    project_slugs, task_index = _build_project_index(projects, errors)
    ctx = _RefContext(account_slugs, calendar_slugs, resource_slugs, project_slugs, task_index)

    # program.lead -> account
    program = payload.get("program", {})
    _check_ref(program.get("lead"), account_slugs, "$.program.lead", "account", errors)

    # resource.calendar -> calendar, resource.account -> account
    for i, resource in enumerate(payload.get("resources", [])):
        base = f"$.resources[{i}]"
        _check_ref(resource.get("calendar"), calendar_slugs, f"{base}.calendar", "calendar", errors)
        _check_ref(resource.get("account"), account_slugs, f"{base}.account", "account", errors)

    # program-scoped risks
    _check_risks(
        payload.get("risks", []), "$.risks", None, account_slugs, task_index, project_slugs, errors
    )

    # per-project references
    for i, project in enumerate(projects):
        _project_reference_errors(i, project, ctx, errors)

    _v21_reference_errors(payload, ctx, errors)
    return errors


def _build_project_index(
    projects: list[dict[str, Any]], errors: list[str]
) -> tuple[set[str], dict[str, set[str]]]:
    """Index project slugs and their wbs paths so task refs resolve anywhere.

    Builds the global task index (project slug -> set of wbs paths) so a task
    ref — bare or ``<project>:<wbs>`` qualified — can be resolved from any
    scope, and records duplicate project slugs while walking.
    """
    project_slugs: set[str] = set()
    task_index: dict[str, set[str]] = {}
    for i, project in enumerate(projects):
        slug = project.get("slug", "")
        path = f"$.projects[{i}]"
        if slug in project_slugs:
            errors.append(f"{path}.slug: duplicate project slug {slug!r}")
        project_slugs.add(slug)
        task_index[slug] = {t.get("wbs_path") for t in project.get("tasks", [])}
    return project_slugs, task_index


def _project_reference_errors(
    i: int, project: dict[str, Any], ctx: _RefContext, errors: list[str]
) -> None:
    """Validate every cross-reference scoped to a single project."""
    slug = project.get("slug", "")
    base = f"$.projects[{i}]"
    _check_ref(project.get("calendar"), ctx.calendar_slugs, f"{base}.calendar", "calendar", errors)
    own_tasks = ctx.task_index.get(slug, set())

    # members[].account -> accounts[] (#3092). A dangling ref here is silent
    # otherwise: the importer resolves it to None and skips the grant, so the
    # persona simply cannot see the project — the exact failure this key exists
    # to fix, reintroduced by a typo.
    for k, member in enumerate(project.get("members", [])):
        _check_ref(
            member.get("account"),
            ctx.account_slugs,
            f"{base}.members[{k}].account",
            "account",
            errors,
        )

    sprint_slugs = _collect_slugs(project.get("sprints", []), f"{base}.sprints", errors)
    # Project labels (ADR-0400, #1958): collect the label catalog so each task's
    # label slug refs can be checked against it (dangling label ref).
    label_slugs = _collect_slugs(project.get("labels", []), f"{base}.labels", errors)
    _check_sprint_milestones(project, base, own_tasks, errors)

    seen_wbs: set[str] = set()
    for j, task in enumerate(project.get("tasks", [])):
        tpath = f"{base}.tasks[{j}]"
        wbs = task.get("wbs_path", "")
        if wbs in seen_wbs:
            errors.append(f"{tpath}.wbs_path: duplicate path {wbs!r} in this project")
        seen_wbs.add(wbs)
        _task_reference_errors(
            task, wbs, tpath, slug, sprint_slugs, label_slugs, own_tasks, ctx, errors
        )

    _check_dependencies(project, base, slug, ctx.task_index, errors)
    _check_baselines(project, base, own_tasks, errors)
    _check_risks(
        project.get("risks", []),
        f"{base}.risks",
        slug,
        ctx.account_slugs,
        ctx.task_index,
        ctx.project_slugs,
        errors,
    )


def _check_sprint_milestones(
    project: dict[str, Any], base: str, own_tasks: set[str], errors: list[str]
) -> None:
    """A sprint's ``target_milestone`` must name a task in the same project."""
    for j, sprint in enumerate(project.get("sprints", [])):
        milestone = sprint.get("target_milestone")
        if milestone is not None and milestone not in own_tasks:
            errors.append(
                f"{base}.sprints[{j}].target_milestone: no task {milestone!r} in this project"
            )


def _task_reference_errors(
    task: dict[str, Any],
    wbs: str,
    tpath: str,
    project_slug: str,
    sprint_slugs: set[str],
    label_slugs: set[str],
    own_tasks: set[str],
    ctx: _RefContext,
    errors: list[str],
) -> None:
    """Validate the cross-references a single task carries."""
    _check_ref(task.get("assignee"), ctx.account_slugs, f"{tpath}.assignee", "account", errors)
    _check_ref(task.get("sprint"), sprint_slugs, f"{tpath}.sprint", "sprint", errors)
    parent = task.get("parent_epic")
    if parent is not None and parent not in own_tasks:
        errors.append(f"{tpath}.parent_epic: no task {parent!r} in this project")
    for k, label_ref in enumerate(task.get("labels", [])):
        _check_ref(label_ref, label_slugs, f"{tpath}.labels[{k}]", "label", errors)
    _check_task_links(task, wbs, project_slug, ctx.task_index, tpath, errors)
    _check_estimate_order(task, tpath, errors)
    for k, assignment in enumerate(task.get("assignments", [])):
        _check_ref(
            assignment.get("resource"),
            ctx.resource_slugs,
            f"{tpath}.assignments[{k}].resource",
            "resource",
            errors,
        )


def _check_task_links(
    task: dict[str, Any],
    wbs: str,
    project_slug: str,
    task_index: dict[str, set[str]],
    tpath: str,
    errors: list[str],
) -> None:
    """Validate informational task-to-task relations (ADR-0455).

    The target must resolve to a real task; a bare wbs is enclosing-project, a
    ``<slug>:<wbs>`` ref a sibling project. Because a seed document is a single
    program, ``_check_task_ref``'s "no project with slug" error is itself the
    cross-program guard — a resolvable target is always in the same program as
    the source (the ADR-0120 D1 envelope). Self-links are rejected here too
    (inert; the DB CheckConstraint is the backstop).
    """
    for k, link in enumerate(task.get("links", [])):
        lpath = f"{tpath}.links[{k}].target"
        target = link.get("target")
        _check_task_ref(target, project_slug, task_index, lpath, errors)
        if target is not None:
            if ":" in target:
                tproj, _, twbs = target.partition(":")
            else:
                tproj, twbs = project_slug, target
            if tproj == project_slug and twbs == wbs:
                errors.append(f"{lpath}: a task cannot link to itself")


def _check_estimate_order(task: dict[str, Any], tpath: str, errors: list[str]) -> None:
    """A complete three-point estimate must be ordered.

    This is the same invariant the engine, the REST serializer, and the DB
    CheckConstraint enforce (#2005). Caught here so a mis-authored seed fails
    loudly at build/CI time (``test_sample_content`` runs ``validate_seed``)
    rather than as a runtime IntegrityError on import.
    """
    est = task.get("estimate")
    if isinstance(est, dict):
        o, m, p = est.get("optimistic"), est.get("most_likely"), est.get("pessimistic")
        if o is not None and m is not None and p is not None and not (o <= m <= p):
            errors.append(
                f"{tpath}.estimate: three-point estimate must satisfy "
                f"optimistic <= most_likely <= pessimistic (got {o} <= {m} <= {p})"
            )


def _check_dependencies(
    project: dict[str, Any],
    base: str,
    project_slug: str,
    task_index: dict[str, set[str]],
    errors: list[str],
) -> None:
    """Both endpoints of every dependency edge must resolve to a task."""
    for j, dep in enumerate(project.get("dependencies", [])):
        dpath = f"{base}.dependencies[{j}]"
        _check_task_ref(
            dep.get("predecessor"), project_slug, task_index, f"{dpath}.predecessor", errors
        )
        _check_task_ref(
            dep.get("successor"), project_slug, task_index, f"{dpath}.successor", errors
        )


def _check_baselines(
    project: dict[str, Any], base: str, own_tasks: set[str], errors: list[str]
) -> None:
    """Every baselined task must name a task in the same project."""
    for j, bl in enumerate(project.get("baselines", [])):
        for k, bt in enumerate(bl.get("tasks", [])):
            ref = bt.get("task")
            if ref not in own_tasks:
                errors.append(
                    f"{base}.baselines[{j}].tasks[{k}].task: no task {ref!r} in this project"
                )


def _collect_slugs(items: list[dict[str, Any]], base: str, errors: list[str]) -> set[str]:
    """Gather slugs from a collection, recording duplicates as errors."""
    slugs: set[str] = set()
    for i, item in enumerate(items):
        slug = item.get("slug", "")
        if slug in slugs:
            errors.append(f"{base}[{i}].slug: duplicate slug {slug!r}")
        slugs.add(slug)
    return slugs


def _check_ref(value: str | None, valid: set[str], path: str, kind: str, errors: list[str]) -> None:
    """A simple slug reference must name an entry in ``valid`` when present."""
    if value is not None and value not in valid:
        errors.append(f"{path}: no {kind} with slug {value!r}")


def _check_task_ref(
    ref: str | None,
    enclosing_project: str,
    task_index: dict[str, set[str]],
    path: str,
    errors: list[str],
) -> None:
    """Resolve a bare or ``<project>:<wbs>`` task ref against the global index."""
    if ref is None:
        return
    if ":" in ref:
        project_slug, _, wbs = ref.partition(":")
    else:
        project_slug, wbs = enclosing_project, ref
    tasks = task_index.get(project_slug)
    if tasks is None:
        errors.append(f"{path}: no project with slug {project_slug!r} for task ref {ref!r}")
    elif wbs not in tasks:
        errors.append(f"{path}: no task {wbs!r} in project {project_slug!r}")


def _check_risks(
    risks: list[dict[str, Any]],
    base: str,
    enclosing_project: str | None,
    account_slugs: set[str],
    task_index: dict[str, set[str]],
    project_slugs: set[str],
    errors: list[str],
) -> None:
    """Validate risk owner and task-linkage references.

    Program-scoped risks (``enclosing_project is None``) must qualify every task
    ref with a project slug, because a bare path has no project to resolve
    against.
    """
    seen: set[str] = set()
    for i, risk in enumerate(risks):
        rpath = f"{base}[{i}]"
        slug = risk.get("slug", "")
        if slug in seen:
            errors.append(f"{rpath}.slug: duplicate risk slug {slug!r}")
        seen.add(slug)
        _check_ref(risk.get("owner"), account_slugs, f"{rpath}.owner", "account", errors)
        for k, ref in enumerate(risk.get("tasks", [])):
            tref_path = f"{rpath}.tasks[{k}]"
            if enclosing_project is None and ":" not in ref:
                errors.append(
                    f"{tref_path}: program-scoped risk task ref {ref!r} must be "
                    f'qualified as "<project-slug>:<wbs-path>"'
                )
                continue
            _check_task_ref(ref, enclosing_project or "", task_index, tref_path, errors)
