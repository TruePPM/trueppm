"""Every ``@action`` must declare its schema, or say in writing why it need not (#2840).

``api:schema-drift`` regenerates ``docs/api/openapi.json`` and asserts it matches
what the *annotations* produce. Where an action carries no annotation there is
nothing to drift from, so the gate stays green while drf-spectacular guesses the
contract from the viewset's ``serializer_class`` — and publishes that guess as the
API's public commitment.

The guess is wrong in three directions, all three of which shipped:

* a **read** serializer has no writable fields, so the operation publishes **no
  requestBody at all** — an SDK method that takes no arguments for an endpoint that
  400s without a body (the eight mention-group roster actions);
* a **write** serializer publishes a *required* full-object body on an action that
  reads nothing from ``request.data`` (``dependencies/{id}/accept``,
  ``resources/{id}/restore``);
* neither side matches when the action's real body and real response are its own
  shapes (``apply-preset``, ``backlog-items/{id}/pull``).

So this is the guard that makes ``api:schema-drift`` mean something: it fails on the
*next* unannotated action rather than waiting for an audit to read the generated
JSON by hand. It is static — no database, no schema generation — so it costs
milliseconds.

Scope note: it walks every module under ``src/trueppm_api/apps/``, not ``views.py``
alone. Restricting the original audit to ``views.py`` is exactly what let
``backlog_views.py``'s ``pull`` (wrong on both request *and* response) go unlisted.
"""

from __future__ import annotations

import ast
from pathlib import Path

API_SRC = Path(__file__).resolve().parents[1] / "src"
APPS = API_SRC / "trueppm_api" / "apps"

# Actions that legitimately need no annotation. Key is "<ClassName>.<method>";
# the value is why the generated contract is already correct, and must be a
# statement a reader can check — not "this one is fine".
#
# Empty on purpose: every action found by the #2840 sweep was annotated rather
# than excused. Add an entry only when the fallback genuinely publishes the truth,
# and remember the fallback is *serializer_class*, so the entry stops being true
# the moment that serializer changes.
ALLOWED_WITHOUT_SCHEMA: dict[str, str] = {}


def _call_name(call: ast.Call) -> str:
    func = call.func
    return func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")


def _extend_schema_view_keys(cls: ast.ClassDef) -> set[str]:
    """Method names covered by a class-level ``@extend_schema_view(...)`` mapping.

    This is the codebase's dominant annotation pattern, and an action named there
    is as covered as one carrying a stacked decorator.
    """
    keys: set[str] = set()
    for decorator in cls.decorator_list:
        if isinstance(decorator, ast.Call) and _call_name(decorator) == "extend_schema_view":
            keys |= {kw.arg for kw in decorator.keywords if kw.arg}
    return keys


def _has_stacked_extend_schema(node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    for decorator in node.decorator_list:
        if isinstance(decorator, ast.Call) and _call_name(decorator) == "extend_schema":
            return True
        if isinstance(decorator, ast.Name) and decorator.id == "extend_schema":
            return True
    return False


def _unannotated_actions(source: str, path: Path) -> list[tuple[str, str]]:
    """Return ``(key, "path:line ClassName.method")`` for each undeclared action."""
    findings: list[tuple[str, str]] = []
    for cls in ast.walk(ast.parse(source)):
        if not isinstance(cls, ast.ClassDef):
            continue
        view_keys = _extend_schema_view_keys(cls)
        for node in cls.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            is_action = any(
                isinstance(d, ast.Call) and _call_name(d) == "action" for d in node.decorator_list
            )
            if not is_action:
                continue
            if _has_stacked_extend_schema(node) or node.name in view_keys:
                continue
            findings.append(
                (f"{cls.name}.{node.name}", f"{path}:{node.lineno} {cls.name}.{node.name}")
            )
    return findings


def _scan() -> list[tuple[str, str]]:
    findings: list[tuple[str, str]] = []
    for path in sorted(APPS.rglob("*.py")):
        if "/migrations/" in str(path):
            continue
        findings.extend(_unannotated_actions(path.read_text(), path))
    return findings


def test_every_action_declares_its_schema_or_is_allow_listed() -> None:
    """No ``@action`` may leave its published contract to drf-spectacular's guess."""
    unlisted = [line for key, line in _scan() if key not in ALLOWED_WITHOUT_SCHEMA]
    assert not unlisted, (
        "These @action methods carry neither a stacked @extend_schema nor an "
        "@extend_schema_view key, so docs/api/openapi.json publishes a contract "
        "inferred from serializer_class rather than one anybody wrote (#2840):\n"
        + "\n".join(unlisted)
    )


def test_allow_list_has_no_stale_entries() -> None:
    """An allow-list entry for an action that is now annotated (or gone) must go.

    A stale exemption is worse than none: it silently re-exempts the next action
    that happens to reuse the name.
    """
    live = {key for key, _ in _scan()}
    stale = sorted(set(ALLOWED_WITHOUT_SCHEMA) - live)
    assert not stale, (
        "ALLOWED_WITHOUT_SCHEMA names actions that are annotated or no longer "
        f"exist — delete these entries: {stale}"
    )


def test_the_guard_detects_a_planted_unannotated_action() -> None:
    """The detector must actually fire — a guard that cannot fail guards nothing.

    Also pins the two coverage forms it must accept, so a future refactor cannot
    make the guard pass by quietly ceasing to recognize either one.
    """
    planted = """
@extend_schema_view(archive=extend_schema(summary="Archive"))
class WidgetViewSet:
    @action(detail=True, methods=["post"])
    def archive(self, request, pk=None): ...

    @extend_schema(request=None)
    @action(detail=True, methods=["post"])
    def restore(self, request, pk=None): ...

    @action(detail=True, methods=["post"])
    def publish(self, request, pk=None): ...

    def not_an_action(self, request): ...
"""
    findings = _unannotated_actions(planted, Path("planted.py"))
    assert [key for key, _ in findings] == ["WidgetViewSet.publish"], findings
