"""An ``@extend_schema`` that omits a status the view actually returns (#3766).

``api:schema-drift`` only proves the committed ``docs/api/openapi.json`` matches
what the *annotations* generate — it has no opinion on whether the annotations
are complete. #1016 found and fixed two operations whose ``responses=`` map
omitted a real ``409``/``201``/``202``; #3766 found the same class recurring on
~15 more, unnoticed because nothing re-checks it between pre-release audits. This
is that re-check, made mechanical: it AST-scans every view method for a literal
``status.HTTP_409_CONFLICT`` / ``status.HTTP_410_GONE`` inside the method (or one
hop through a same-file helper it calls, e.g. ``_PokerBase._conflict``) and
asserts the method's own declared ``responses=`` — whether via a stacked
``@extend_schema``, an ``@extend_schema_view`` class mapping, or a bare
``@extend_schema`` on a single-method ``APIView`` class — includes that code.

Static — no database, no schema generation — so it costs milliseconds, the same
shape as ``test_action_schema_coverage.py`` and ``test_extend_schema_placement.py``.

**Scoped to 409/410 only, deliberately.** 400/403/429 each have a *legitimate*
codebase-wide auto-injection path (``TruePPMAutoSchema.get_operation`` in
``core/openapi.py``, keyed off ``requestBody`` presence / throttle_classes /
``IsNotTokenAuthenticated``) that this static scanner cannot see without
duplicating that runtime logic — scanning for them here would either produce a
wall of false positives or require re-deriving view-attribute state this test
has no request/view instance to read. 409/410 are exactly the class #1016 and
#3766 both found recurring, and neither has an auto-injection path, so they are
the tractable, high-signal slice. Widening the tracked set is possible but is a
separate, larger effort — see the module docstring history in #3766's MR.

**One-hop indirection, not full call-graph resolution.** A view method that
returns its conflict via a same-class-family helper (``self._conflict(exc)``,
whose body — anywhere in the same file, not just the same class, since Python
inheritance can put the helper on a different class than the caller — holds the
literal) is resolved one hop by *method name*, not by verified receiver type.
This is deliberately loose: exact call-graph resolution across `self`/base-class
boundaries is a much larger static-analysis project, and callee-name collisions
across a whole file are rare enough in this codebase that the loose match's
false-negative risk (silently missing a real gap) is preferred over the
much-larger effort of building precise resolution — while a false *positive*
here is caught by the ``ALLOWED_WITHOUT_409`` waiver, symmetrically with the
other guards in this file.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

API_SRC = Path(__file__).resolve().parents[1] / "src"
APPS = API_SRC / "trueppm_api" / "apps"

#: Status codes this guard tracks. See the module docstring for why the set
#: stops at these two rather than every 4xx/5xx.
TRACKED_CODES = {"409", "410"}

_CODE_ATTR_RE = re.compile(r"^HTTP_(\d{3})_")

_VIEW_METHOD_NAMES = {
    # Bare APIView / function-based-view HTTP verbs.
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
    "options",
    # DRF ModelViewSet/GenericViewSet action names.
    "list",
    "create",
    "retrieve",
    "update",
    "partial_update",
    "destroy",
}

# Operations the scanner cannot resolve, or must not touch right now. Ratcheted:
# entries are removed once the code is fixed or the scanner learns to see it —
# never added just to silence a real, actionable finding.
#
# Key is "ClassName.method_name"; value is (reason, issue).
ALLOWED_WITHOUT_409: dict[str, tuple[str, str]] = {
    "ProjectResourceViewSet.destroy": (
        "The has_assignments 409-vs-2xx refusal on this endpoint is being "
        "reworked in #3768 (in flight as of #3766) — annotating the current "
        "409 here would conflict with that change re-deciding what the "
        "refusal even is.",
        "#3768",
    ),
}


def _call_name(call: ast.Call) -> str:
    func = call.func
    return func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")


def _tracked_codes_in_body(node: ast.AST) -> set[str]:
    """Tracked status codes referenced anywhere inside ``node``.

    Deliberately coarse — it does not verify the attribute is read off the
    ``status`` module, nor that it reaches the wire via ``Response(status=...)``
    rather than, say, a comment-adjacent dead branch. False positives from that
    looseness go through ``ALLOWED_WITHOUT_409`` like any other unresolvable
    case; in practice every hit in this codebase is a real
    ``Response(..., status=status.HTTP_409_CONFLICT)``.
    """
    codes: set[str] = set()
    for sub in ast.walk(node):
        if isinstance(sub, ast.Attribute):
            m = _CODE_ATTR_RE.match(sub.attr)
            if m and m.group(1) in TRACKED_CODES:
                codes.add(m.group(1))
    return codes


def _responses_dict_codes(call: ast.Call) -> set[str]:
    """Int/str literal keys of a ``responses={...}`` kwarg on an ``extend_schema(...)`` call."""
    codes: set[str] = set()
    for kw in call.keywords:
        if kw.arg == "responses" and isinstance(kw.value, ast.Dict):
            for key in kw.value.keys:
                if isinstance(key, ast.Constant):
                    codes.add(str(key.value))
    return codes


def _stacked_declared_codes(node: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str] | None:
    """Declared codes from a stacked ``@extend_schema(...)`` on the method itself."""
    for d in node.decorator_list:
        if isinstance(d, ast.Call) and _call_name(d) == "extend_schema":
            return _responses_dict_codes(d)
    return None


def _class_view_declared_codes(cls: ast.ClassDef) -> dict[str, set[str]]:
    """``{method_name: declared codes}`` from an ``@extend_schema_view(...)`` class decorator."""
    result: dict[str, set[str]] = {}
    for d in cls.decorator_list:
        if isinstance(d, ast.Call) and _call_name(d) == "extend_schema_view":
            for kw in d.keywords:
                if (
                    kw.arg
                    and isinstance(kw.value, ast.Call)
                    and _call_name(kw.value) == "extend_schema"
                ):
                    result[kw.arg] = _responses_dict_codes(kw.value)
    return result


def _class_bare_extend_schema_codes(cls: ast.ClassDef) -> set[str] | None:
    """Codes from a bare ``@extend_schema(...)`` applied directly to the class.

    A single-method ``APIView`` is sometimes annotated this way instead of via
    ``extend_schema_view`` — drf-spectacular applies it to whichever HTTP method
    the view defines.
    """
    for d in cls.decorator_list:
        if isinstance(d, ast.Call) and _call_name(d) == "extend_schema":
            return _responses_dict_codes(d)
    return None


def _is_view_entrypoint(node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    if node.name in _VIEW_METHOD_NAMES:
        return True
    return any(isinstance(d, ast.Call) and _call_name(d) == "action" for d in node.decorator_list)


def _body_codes(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    method_bodies: dict[str, ast.FunctionDef | ast.AsyncFunctionDef],
) -> set[str]:
    """Tracked codes returned directly, or one hop through a same-file callee."""
    direct = _tracked_codes_in_body(node)
    indirect: set[str] = set()
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute):
            callee_name = sub.func.attr
            if callee_name != node.name and callee_name in method_bodies:
                indirect |= _tracked_codes_in_body(method_bodies[callee_name])
    return (direct | indirect) & TRACKED_CODES


def _declared_codes(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    view_codes: dict[str, set[str]],
    class_bare_codes: set[str] | None,
) -> set[str]:
    """A method's declared codes: own stacked decorator, else the class-level forms."""
    declared = _stacked_declared_codes(node)
    if declared is None:
        declared = view_codes.get(node.name)
    if declared is None:
        declared = class_bare_codes
    return declared if declared is not None else set()


def _scan_class(
    cls: ast.ClassDef,
    path: Path,
    method_bodies: dict[str, ast.FunctionDef | ast.AsyncFunctionDef],
) -> list[tuple[str, str]]:
    view_codes = _class_view_declared_codes(cls)
    class_bare_codes = _class_bare_extend_schema_codes(cls)
    findings: list[tuple[str, str]] = []
    for node in cls.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not _is_view_entrypoint(node):
            continue
        body_codes = _body_codes(node, method_bodies)
        if not body_codes:
            continue
        missing = body_codes - _declared_codes(node, view_codes, class_bare_codes)
        if missing:
            key = f"{cls.name}.{node.name}"
            findings.append(
                (key, f"{path}:{node.lineno} {key} returns {sorted(missing)} undeclared")
            )
    return findings


def _scan_source(source: str, path: Path) -> list[tuple[str, str]]:
    """Return ``(key, "path:line ClassName.method missing [...]")`` for each gap."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []

    # Whole-file method-name map for the one-hop indirection resolution — see
    # the module docstring for why this is by name only, not by receiver type.
    method_bodies: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            method_bodies.setdefault(node.name, node)

    findings: list[tuple[str, str]] = []
    for cls in ast.walk(tree):
        if isinstance(cls, ast.ClassDef):
            findings.extend(_scan_class(cls, path, method_bodies))
    return findings


def _scan() -> list[tuple[str, str]]:
    findings: list[tuple[str, str]] = []
    for path in sorted(APPS.rglob("*.py")):
        if "/migrations/" in str(path):
            continue
        findings.extend(_scan_source(path.read_text(), path))
    return findings


def test_every_conflict_response_is_declared() -> None:
    """No view method may return a 409/410 its own ``responses=`` omits (#3766)."""
    unlisted = [line for key, line in _scan() if key not in ALLOWED_WITHOUT_409]
    assert not unlisted, (
        "These view methods return a status this guard tracks (409/410) that "
        "their own declared responses= does not include, so "
        "docs/api/openapi.json silently omits a real refusal shape (#1016, "
        "#3766). Add the missing code(s) to the operation's "
        "@extend_schema(responses=...), or — only if the scanner genuinely "
        "cannot resolve this site — add a reasoned ALLOWED_WITHOUT_409 entry:\n"
        + "\n".join(unlisted)
    )


def test_allow_list_has_no_stale_entries() -> None:
    """A waiver for a method that is now annotated (or gone) must be removed.

    A stale waiver is worse than none: it silently re-exempts the next method
    that happens to reuse the same class/method name.
    """
    live = {key for key, _ in _scan()}
    stale = sorted(set(ALLOWED_WITHOUT_409) - live)
    assert not stale, (
        "ALLOWED_WITHOUT_409 names methods that now declare their 409/410 (or "
        f"no longer exist) — delete these entries: {stale}"
    )


def test_the_guard_detects_a_planted_violation() -> None:
    """The detector must actually fire — a guard that cannot fail guards nothing.

    Also pins the three coverage forms it must accept: a stacked
    ``@extend_schema`` that declares the code (covered), one that omits it
    (flagged), and no annotation at all (flagged).
    """
    planted = """
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView


class WidgetView(APIView):
    @extend_schema(responses={200: None, 409: None})
    def post(self, request):
        if bad:
            return Response({}, status=status.HTTP_409_CONFLICT)
        return Response({})

    @extend_schema(responses={200: None})
    def patch(self, request):
        if bad:
            return Response({}, status=status.HTTP_409_CONFLICT)
        return Response({})

    def delete(self, request):
        if bad:
            return Response({}, status=status.HTTP_409_CONFLICT)
        return Response({}, status=204)
"""
    findings = {key for key, _ in _scan_source(planted, Path("planted.py"))}
    assert findings == {"WidgetView.patch", "WidgetView.delete"}, findings
