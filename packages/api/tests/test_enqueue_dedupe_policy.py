"""Every outbox enqueue states whether it deduplicates (#2996).

#2996 was not a novel defect — it was the **one** member of an established set that
had never been given the treatment the other six already had. `enqueue_project_export`,
`enqueue_program_export`, `enqueue_program_import`, `enqueue_workspace_export`,
`enqueue_external_sync` and `enqueue_recalculate` all look for a live row before
inserting one; `enqueue_sprint_close` did not, so every repeat POST bought another
worker dispatch (and, since #2894's retry budget, up to three attempts each).

Nothing enforced that convention, so the seventh member was invisible. This test is
the mechanism: every ``enqueue_*`` function in the API must appear in ``POLICY`` below,
classified as either DEDUPES or NO_DEDUPE with a stated reason. A new enqueue helper
fails this test until somebody makes that call deliberately.

It deliberately does **not** try to infer the right policy — that is a semantic
judgement (a cascade helper writes no row at all; a template application may legitimately
be repeated). What it removes is the silence: an unclassified enqueue is now a failure
rather than something nobody notices until it amplifies in production.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

API_SRC = pathlib.Path(__file__).resolve().parents[1] / "src" / "trueppm_api"

DEDUPES = "dedupes"
NO_DEDUPE = "no-dedupe"

# name -> (policy, why). Keep the reason concrete: it is the whole value of the row.
POLICY: dict[str, tuple[str, str]] = {
    "enqueue_sprint_close": (
        DEDUPES,
        "At most one live close per sprint (#2996). Live = PENDING/IN_FLIGHT, or FAILED "
        "with a non-null next_attempt_at.",
    ),
    "enqueue_project_export": (DEDUPES, "Returns an existing PENDING/RUNNING export job."),
    "enqueue_program_export": (DEDUPES, "Returns an existing PENDING/RUNNING export job."),
    "enqueue_program_import": (
        DEDUPES,
        "Returns an existing PENDING/RUNNING import job — an async import must not become "
        "an unbounded multiplier of a bounded request.",
    ),
    "enqueue_workspace_export": (DEDUPES, "Returns an existing PENDING/RUNNING export job."),
    "enqueue_external_sync": (
        DEDUPES,
        "Adopts the PENDING row for (user, source), backed by a partial-unique constraint.",
    ),
    "enqueue_recalculate": (
        DEDUPES,
        "Adopts a PENDING ScheduleRequest for the project, coalescing bursts of edits.",
    ),
    "enqueue_project_cascade_soft_delete": (
        NO_DEDUPE,
        "Writes no outbox row at all — it only defers an idempotent cascade, so a repeat "
        "dispatch is a no-op rather than duplicated work.",
    ),
    "enqueue_template_apply": (
        NO_DEDUPE,
        "Structurally the same shape as pre-fix enqueue_sprint_close, but bounded by "
        "SeedImportThrottle on the apply action, and a TemplateApplication row is adoption "
        "HISTORY that a dedupe would swallow. Whether a second concurrent apply to the same "
        "project should 409 is an open product question — see the #2996 follow-up.",
    ),
    "enqueue_import": (
        NO_DEDUPE,
        "Takes an already-persisted ImportRequest id; the row is created by the upload view, "
        "so this helper only dispatches and has nothing to deduplicate.",
    ),
    "enqueue_jira_import": (NO_DEDUPE, "Dispatch-only for an existing JiraImportRequest id."),
    "enqueue_csv_import": (NO_DEDUPE, "Dispatch-only for an existing CsvImportRequest id."),
    "enqueue_step": (
        NO_DEDUPE,
        "Workflow step dispatch keyed on (instance, step_index); advancing the same step "
        "twice is guarded by the workflow instance's own state machine.",
    ),
}


def _enqueue_functions() -> dict[str, pathlib.Path]:
    """Every module-level ``enqueue_*`` def under the API source tree."""
    found: dict[str, pathlib.Path] = {}
    for path in API_SRC.rglob("*.py"):
        if "/migrations/" in str(path):
            continue
        try:
            tree = ast.parse(path.read_text())
        except SyntaxError:  # pragma: no cover - the tree must parse for anything to work
            continue
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name.startswith("enqueue_"):
                found[node.name] = path
    return found


def test_every_enqueue_helper_declares_a_dedupe_policy() -> None:
    discovered = _enqueue_functions()

    unclassified = sorted(set(discovered) - set(POLICY))
    assert not unclassified, (
        "New enqueue helper(s) with no dedupe policy: "
        + ", ".join(f"{n} ({discovered[n].relative_to(API_SRC)})" for n in unclassified)
        + ". Decide whether a repeat call must adopt an already-live row (#2996) and add it "
        "to POLICY with the reason."
    )

    stale = sorted(set(POLICY) - set(discovered))
    assert not stale, f"POLICY names enqueue helper(s) that no longer exist: {stale}"


@pytest.mark.parametrize(
    "name", sorted(n for n, (policy, _) in POLICY.items() if policy == DEDUPES)
)
def test_declared_deduplicating_helpers_look_for_a_live_row_before_inserting(name: str) -> None:
    """A DEDUPES claim must be visible in the source, not just asserted here.

    Cheap structural check: the function body must query for an existing row. It cannot
    prove the predicate is *correct* — the per-helper tests do that — but it does catch a
    helper whose dedupe branch is deleted while its POLICY entry still claims it.
    """
    path = _enqueue_functions()[name]
    tree = ast.parse(path.read_text())
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
    lookups = {
        node.attr
        for node in ast.walk(fn)
        if isinstance(node, ast.Attribute) and node.attr in {"filter", "get_or_create"}
    }
    assert lookups, (
        f"{name} is declared as {DEDUPES} but its body never queries for an existing row"
    )
