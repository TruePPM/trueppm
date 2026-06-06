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
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

# Highest schema version this validator understands. The major component is the
# compatibility boundary: a payload whose major differs is rejected outright
# (a future v2 importer would ship its own schema + shim). See ADR-0109.
SUPPORTED_SCHEMA_VERSION = "1.0"

_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schemas" / "seed_v1.json"


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


@lru_cache(maxsize=1)
def _validator() -> Draft202012Validator:
    """Build (once) the schema validator with date/email format checking on.

    ``format`` is an annotation in JSON Schema by default; we opt into checking
    it so ``"2026-13-40"`` in a ``planned_start`` is caught here rather than
    blowing up later at ``date.fromisoformat`` time during import.
    """
    schema = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    return Draft202012Validator(schema, format_checker=FormatChecker())


def _json_path(absolute_path: Any) -> str:
    """Render a jsonschema error path as ``$.projects[0].tasks[2].wbs_path``."""
    out = "$"
    for part in absolute_path:
        out += f"[{part}]" if isinstance(part, int) else f".{part}"
    return out


def validate_seed(payload: Any) -> None:
    """Validate a parsed seed document. Returns ``None`` on success.

    Args:
        payload: the already-parsed JSON (a ``dict``), not a raw string.

    Raises:
        SeedValidationError: with one message per problem found.
    """
    if not isinstance(payload, dict):
        raise SeedValidationError(["$: seed document must be a JSON object"])

    # Version gate first — a mismatched major means the rest of the schema may
    # not apply, so fail fast with a clear message before structural checks.
    version = payload.get("schema_version")
    if version is None:
        raise SeedValidationError(["$.schema_version: required and missing"])
    if (
        not isinstance(version, str)
        or version.split(".")[0] != SUPPORTED_SCHEMA_VERSION.split(".")[0]
    ):
        raise SeedValidationError(
            [
                f"$.schema_version: unsupported version {version!r}; "
                f"this build supports {SUPPORTED_SCHEMA_VERSION!r}"
            ]
        )

    errors: list[str] = [
        f"{_json_path(e.absolute_path)}: {e.message}"
        for e in sorted(_validator().iter_errors(payload), key=lambda e: list(e.absolute_path))
    ]

    # Referential integrity only runs when the document is structurally sound —
    # the cross-reference walk assumes well-typed slugs and arrays.
    if not errors:
        errors.extend(_referential_errors(payload))

    if errors:
        raise SeedValidationError(errors)


def _referential_errors(payload: dict[str, Any]) -> list[str]:
    """Check duplicate slugs and dangling cross-references (ADR-0109 identity)."""
    errors: list[str] = []

    account_slugs = _collect_slugs(payload.get("accounts", []), "$.accounts", errors)
    calendar_slugs = _collect_slugs(payload.get("calendars", []), "$.calendars", errors)
    resource_slugs = _collect_slugs(payload.get("resources", []), "$.resources", errors)

    # Build the global task index (project slug -> set of wbs paths) so task
    # refs — bare or "<project>:<wbs>" qualified — can be resolved anywhere.
    projects = payload.get("projects", [])
    project_slugs: set[str] = set()
    task_index: dict[str, set[str]] = {}
    for i, project in enumerate(projects):
        slug = project.get("slug")
        path = f"$.projects[{i}]"
        if slug in project_slugs:
            errors.append(f"{path}.slug: duplicate project slug {slug!r}")
        project_slugs.add(slug)
        task_index[slug] = {t.get("wbs_path") for t in project.get("tasks", [])}

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
        slug = project.get("slug")
        base = f"$.projects[{i}]"
        _check_ref(project.get("calendar"), calendar_slugs, f"{base}.calendar", "calendar", errors)
        own_tasks = task_index.get(slug, set())

        sprint_slugs = _collect_slugs(project.get("sprints", []), f"{base}.sprints", errors)
        for j, sprint in enumerate(project.get("sprints", [])):
            milestone = sprint.get("target_milestone")
            if milestone is not None and milestone not in own_tasks:
                errors.append(
                    f"{base}.sprints[{j}].target_milestone: no task {milestone!r} in this project"
                )

        seen_wbs: set[str] = set()
        for j, task in enumerate(project.get("tasks", [])):
            tpath = f"{base}.tasks[{j}]"
            wbs = task.get("wbs_path")
            if wbs in seen_wbs:
                errors.append(f"{tpath}.wbs_path: duplicate path {wbs!r} in this project")
            seen_wbs.add(wbs)
            _check_ref(task.get("assignee"), account_slugs, f"{tpath}.assignee", "account", errors)
            _check_ref(task.get("sprint"), sprint_slugs, f"{tpath}.sprint", "sprint", errors)
            parent = task.get("parent_epic")
            if parent is not None and parent not in own_tasks:
                errors.append(f"{tpath}.parent_epic: no task {parent!r} in this project")
            for k, assignment in enumerate(task.get("assignments", [])):
                _check_ref(
                    assignment.get("resource"),
                    resource_slugs,
                    f"{tpath}.assignments[{k}].resource",
                    "resource",
                    errors,
                )

        for j, dep in enumerate(project.get("dependencies", [])):
            dpath = f"{base}.dependencies[{j}]"
            _check_task_ref(
                dep.get("predecessor"), slug, task_index, f"{dpath}.predecessor", errors
            )
            _check_task_ref(dep.get("successor"), slug, task_index, f"{dpath}.successor", errors)

        for j, bl in enumerate(project.get("baselines", [])):
            for k, bt in enumerate(bl.get("tasks", [])):
                ref = bt.get("task")
                if ref not in own_tasks:
                    errors.append(
                        f"{base}.baselines[{j}].tasks[{k}].task: no task {ref!r} in this project"
                    )

        _check_risks(
            project.get("risks", []),
            f"{base}.risks",
            slug,
            account_slugs,
            task_index,
            project_slugs,
            errors,
        )

    return errors


def _collect_slugs(items: list[dict[str, Any]], base: str, errors: list[str]) -> set[str]:
    """Gather slugs from a collection, recording duplicates as errors."""
    slugs: set[str] = set()
    for i, item in enumerate(items):
        slug = item.get("slug")
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
        slug = risk.get("slug")
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
