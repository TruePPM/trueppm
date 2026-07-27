"""Guard against ``@extend_schema`` drifting onto the neighboring action (#2455).

A stacked decorator block is anchored only by whatever ``def`` follows it. Insert a
new ``@action`` between an existing ``@extend_schema`` stack and the method it was
written for, and Python silently reassigns every one of those blocks to the new
action — the original endpoint falls back to ``serializer_class`` and the new one
publishes the old endpoint's summary and response.

Nothing else in the harness sees this. ``api:schema-drift`` only proves the
committed schema matches what the code generates, and here the code generated the
wrong thing perfectly; the nightly fuzzer caught one downstream symptom
(``GET /programs/{id}/export/`` validated against ``Program``) six failures deep
into a two-week streak, and three further misdocumented endpoints not at all.

This is a static check, not a schema assertion: it reads the source and needs no
database, so it fails in milliseconds at the moment the stack drifts.
"""

from __future__ import annotations

import ast
from pathlib import Path

API_SRC = Path(__file__).resolve().parents[1] / "src"


def _method_literals(node: ast.expr | None) -> set[str] | None:
    """Lower-cased HTTP verbs from a ``methods=[...]`` literal, or None if dynamic."""
    if not isinstance(node, (ast.List, ast.Tuple)):
        return None
    verbs = {
        elt.value.lower()
        for elt in node.elts
        if isinstance(elt, ast.Constant) and isinstance(elt.value, str)
    }
    return verbs or None


def _call_name(call: ast.Call) -> str:
    func = call.func
    return func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")


def _orphaned_blocks(source: str, path: Path) -> list[str]:
    """Report every ``@extend_schema(methods=…)`` whose verbs its ``@action`` forbids."""
    findings: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue

        action_verbs: set[str] | None = None
        annotations: list[tuple[int, set[str]]] = []
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call):
                continue
            keywords = {kw.arg: kw.value for kw in decorator.keywords}
            name = _call_name(decorator)
            if name == "action":
                action_verbs = _method_literals(keywords.get("methods"))
            elif name == "extend_schema":
                verbs = _method_literals(keywords.get("methods"))
                if verbs is not None:
                    annotations.append((decorator.lineno, verbs))

        # Only `@action`-decorated methods are checkable: a plain viewset method's
        # verbs come from the router, not from a literal we can read here.
        if action_verbs is None:
            continue
        for lineno, verbs in annotations:
            if not verbs <= action_verbs:
                findings.append(
                    f"{path}:{lineno} — @extend_schema(methods={sorted(verbs)}) sits on "
                    f"{node.name}(), whose @action only serves {sorted(action_verbs)}. "
                    f"The block most likely belongs to the action below it (#2455)."
                )
    return findings


def test_no_extend_schema_block_declares_verbs_its_action_rejects() -> None:
    """An ``@extend_schema(methods=…)`` must name verbs its own ``@action`` serves.

    A block naming a verb the action does not serve is dead — drf-spectacular skips
    it — which is precisely the fingerprint of a stack that slid onto the wrong
    method. The converse (a block with no ``methods=`` at all) is legitimate and
    deliberately not flagged: it applies to every verb of whatever it decorates.
    """
    findings: list[str] = []
    for path in sorted(API_SRC.rglob("*.py")):
        if "/migrations/" in str(path):
            continue
        findings.extend(_orphaned_blocks(path.read_text(), path))

    assert not findings, "Orphaned @extend_schema blocks:\n" + "\n".join(findings)


def test_the_guard_detects_a_planted_orphan() -> None:
    """The detector must actually fire — a guard that cannot fail guards nothing.

    Reproduces the #2455 shape verbatim: a GET-only annotation stranded above a
    POST/DELETE action by an action inserted underneath it.
    """
    planted = """
class ProgramViewSet:
    @extend_schema(methods=["GET"], summary="Export the program as a JSON seed")
    @extend_schema(summary="Pin or unpin this program")
    @action(detail=True, methods=["post", "delete"], url_path="pin")
    def pin(self, request, pk=None): ...

    @action(detail=True, methods=["get", "post"], url_path="export")
    def export(self, request, pk=None): ...
"""
    findings = _orphaned_blocks(planted, Path("planted.py"))
    assert len(findings) == 1, f"expected exactly one finding, got {findings}"
    assert "pin()" in findings[0]
    assert "['get']" in findings[0]
