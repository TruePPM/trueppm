"""The single WS event scanner: what the API broadcasts, what the web app handles (#3775).

Why this module exists rather than a second scan somewhere else. Three independent
audits each found a *different slice of one class* — a `broadcast_board_event()`
event type with no frontend consumer (#2847: `label_*`, `task_relation_created`,
`sprint_reranked`, `project_restored`; #3245: `project_calendar_changed`; the 0.4
pre-release pass: `task_relation_updated/_deleted`, the signal-privacy ceiling
events, the velocity-suggestion events). None was looking for the others' findings
and none could have found them, because the only mechanism was convention plus
review. A conformance test for exactly this was proposed in #2845's fix plan and
never built.

The emitter half is **not** a new scan. It is the AST sweep that
``test_ws_event_type_set_is_frozen`` has used since #1019, moved here verbatim so
the freeze guard and this gate can never disagree about what the API emits — a
second, divergent scanner is how the two halves of a contract drift apart in the
first place. In particular it still follows ONE level of wrapper indirection
(#1381): a helper that forwards one of its *parameters* into a broadcast helper's
``event_type`` slot is itself an emitter, and its real event types are the
literals at its own call sites (``taskruns/tracker.py:_broadcast``,
``retro_board_services.py:_broadcast``).

Consumed by two entry points, which is the point of it being a module:

* ``tests/apps/sync/test_broadcast.py`` — runs in ``api:test``, which is gated on
  ``changes: packages/api/**``.
* ``scripts/check-ws-handler-conformance.sh`` — the ``lint:ws-handler-conformance``
  CI job, which runs unconditionally. A deleted handler is a **web-only** diff, so
  a pytest-only gate would be blind to exactly the edit that breaks it.

Everything here is stdlib-only and imports no Django, so the alpine gate job can
load it with nothing installed.
"""

from __future__ import annotations

import ast
import pathlib
import re
from collections.abc import Mapping
from dataclasses import dataclass

BROADCAST_HELPERS = frozenset({"broadcast_board_event", "abroadcast_board_event"})


class ScanError(RuntimeError):
    """The scanner could not run, or ran and inspected nothing.

    Raised for setup faults and for vacuity — zero broadcast call sites, zero
    handler registrations, an ``on(...)`` form the parser cannot read. A gate that
    reports OK because it tested nothing is worse than no gate, so these are a
    distinct failure (exit 2) from a real violation (exit 1) and are never
    swallowed.
    """


# ---------------------------------------------------------------------------
# Emitter half — the #1019 / #1381 AST sweep.
# ---------------------------------------------------------------------------


def callee_name(call: ast.Call) -> str | None:
    func = call.func
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return None


def str_const(node: ast.expr | None) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def event_type_arg(call: ast.Call) -> ast.expr | None:
    """The node in a helper call's ``event_type`` slot (2nd positional / kw)."""
    if len(call.args) >= 2:
        return call.args[1]
    for kw in call.keywords:
        if kw.arg == "event_type":
            return kw.value
    return None


def find_broadcast_wrappers(tree: ast.Module) -> dict[str, list[tuple[str, int]]]:
    """Pass 1 — wrapper functions in one module.

    A wrapper forwards one of its *parameters* into a helper's ``event_type`` slot.
    Returns, per wrapper name, the parameter name and the positional index that
    parameter occupies at the wrapper's call sites — a bound method drops
    ``self``/``cls``, so the call-site index is one less than the def index.
    """
    wrappers: dict[str, list[tuple[str, int]]] = {}
    for fn in ast.walk(tree):
        if not isinstance(fn, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        params = [a.arg for a in fn.args.posonlyargs] + [a.arg for a in fn.args.args]
        is_method = bool(params) and params[0] in {"self", "cls"}
        for sub in ast.walk(fn):
            if not isinstance(sub, ast.Call) or callee_name(sub) not in BROADCAST_HELPERS:
                continue
            ev = event_type_arg(sub)
            if isinstance(ev, ast.Name) and ev.id in params:
                def_index = params.index(ev.id)
                wrappers.setdefault(fn.name, []).append(
                    (ev.id, def_index - 1 if is_method else def_index)
                )
    return wrappers


def wrapper_call_literals(call: ast.Call, slots: list[tuple[str, int]]) -> set[str]:
    """Event-type literals passed at one wrapper call site, positionally or by keyword."""
    found: set[str] = set()
    for param_name, call_index in slots:
        if 0 <= call_index < len(call.args):
            lit = str_const(call.args[call_index])
            if lit is not None:
                found.add(lit)
        for kw in call.keywords:
            if kw.arg == param_name:
                lit = str_const(kw.value)
                if lit is not None:
                    found.add(lit)
    return found


def literals_in_module(tree: ast.Module, wrappers: dict[str, list[tuple[str, int]]]) -> set[str]:
    """Pass 2 — literals from direct helper calls and from calls to a known wrapper."""
    found: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = callee_name(node)
        if name in BROADCAST_HELPERS:
            lit = str_const(event_type_arg(node))
            if lit is not None:
                found.add(lit)
        elif name in wrappers:
            found |= wrapper_call_literals(node, wrappers[name])
    return found


def count_broadcast_call_sites(tree: ast.Module) -> int:
    """Direct calls to a broadcast helper in one module — the vacuity denominator."""
    return sum(
        1
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and callee_name(node) in BROADCAST_HELPERS
    )


def broadcast_event_types_in_source(api_src: pathlib.Path) -> set[str]:
    """AST-scan an API source tree for literal event types reaching the broadcast helpers.

    Raises:
        ScanError: the tree holds no ``broadcast_board_event()`` call site at all,
            which means the helper was renamed or the path is wrong. Returning an
            empty set there would make every downstream check pass vacuously.
    """
    if not api_src.is_dir():
        raise ScanError(f"API source tree not found: {api_src}")
    found: set[str] = set()
    call_sites = 0
    for path in sorted(api_src.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), str(path))
        wrappers = find_broadcast_wrappers(tree)
        found |= literals_in_module(tree, wrappers)
        call_sites += count_broadcast_call_sites(tree)
    if call_sites == 0:
        raise ScanError(
            f"found no broadcast_board_event() call sites under {api_src}. The scanner "
            "is broken or the helper was renamed; a gate that inspects nothing must "
            "not report success."
        )
    return found


# ---------------------------------------------------------------------------
# Handler half — the `on(...)` registration table in useProjectWebSocket.ts.
# ---------------------------------------------------------------------------

# `on(` not preceded by a word char, `.` or `$`, so a member call (`socket.on(`)
# or an identifier ending in "on" can never be mistaken for a registration.
_ON_CALL_RE = re.compile(r"(?<![\w.$])on\(")
# The same call with its first argument, which must be a string literal or an
# array literal of them. Anything else is a ScanError, not a silent skip. Run
# against MASKED source, where every literal's content is an opaque token, so the
# bracket/quote classes below can never run past a delimiter that lived in text.
_ON_ARG_RE = re.compile(r"(?<![\w.$])on\(\s*(\[[^\]]*\]|'[^']*'|\"[^\"]*\")", re.S)
_STRING_TOKEN_RE = re.compile("\x00(\\d+)\x00")
_EVENT_NAME_RE = re.compile(r"[A-Za-z0-9_]+")


def mask_ts_source(source: str) -> tuple[str, list[str]]:
    """Blank comments and replace every string literal's *content* with an opaque token.

    Returns the masked source and the literal contents, indexed by token.

    Two failure modes this closes, both of which make a real gap read as covered:

    1. **Comments.** The hook opens with a doc block naming most event types in
       prose, so a regex over raw source would "find" a handler for an event that
       appears only in a sentence about it.
    2. **String literals.** ``on(`` inside a *string* — an error message, a log
       line, a doc string in the code — is not a registration, but it looks
       exactly like one to a scanner that only strips comments. That is the
       silent-false-pass this whole gate exists to prevent, one level up: it would
       mask a genuine ``emitted-no-handler`` finding.

    Masking the content rather than deleting the literal keeps the quotes in
    place, so an ``on('x', …)`` argument is still parseable — the token just has
    to be looked up afterwards. Newlines are preserved throughout so reported line
    numbers stay true. Template literals are treated as strings.
    """
    out: list[str] = []
    literals: list[str] = []
    i = 0
    n = len(source)
    while i < n:
        ch = source[i]
        if ch == "/" and i + 1 < n and source[i + 1] == "*":
            end = source.find("*/", i + 2)
            block = source[i : n if end < 0 else end + 2]
            out.append("\n" * block.count("\n"))
            i = n if end < 0 else end + 2
            continue
        if ch == "/" and i + 1 < n and source[i + 1] == "/":
            end = source.find("\n", i)
            i = n if end < 0 else end
            continue
        if ch in "\"'`":
            quote = ch
            i += 1
            body: list[str] = []
            while i < n:
                if source[i] == "\\":
                    body.append(source[i : i + 2])
                    i += 2
                    continue
                if source[i] == quote:
                    i += 1
                    break
                body.append(source[i])
                i += 1
            content = "".join(body)
            out.append(f"{quote}\x00{len(literals)}\x00{quote}")
            out.append("\n" * content.count("\n"))
            literals.append(content)
            continue
        out.append(ch)
        i += 1
    return "".join(out), literals


def handler_registrations_in_source(ts_path: pathlib.Path) -> list[str]:
    """Every event type an ``on(...)`` call registers, in source order, with duplicates.

    Duplicates are deliberately **not** collapsed. ``on()`` is last-write-wins
    (``eventHandlers[type] = handler``), so a second registration for a type
    silently replaces the first — a real defect the hook's own comments warn about
    twice. Callers surface it as a finding; a ``set()`` here would erase it.

    Reads MASKED source (see :func:`mask_ts_source`), so neither a comment nor a
    string literal can contribute a registration that is not one.

    Raises:
        ScanError: the file is missing, registers nothing, or contains an
            ``on(...)`` whose first argument is not a literal the parser can read.
    """
    if not ts_path.is_file():
        raise ScanError(f"WS handler module not found: {ts_path}")
    masked, literals = mask_ts_source(ts_path.read_text(encoding="utf-8"))

    calls = list(_ON_CALL_RE.finditer(masked))
    parsed = list(_ON_ARG_RE.finditer(masked))
    if not calls:
        raise ScanError(
            f"found no on(...) handler registrations in {ts_path}. The registration "
            "table moved or was renamed; a gate that inspects nothing must not "
            "report success."
        )
    if len(calls) != len(parsed):
        unreadable = sorted(
            {masked.count("\n", 0, m.start()) + 1 for m in calls}
            - {masked.count("\n", 0, m.start()) + 1 for m in parsed}
        )
        raise ScanError(
            f"{ts_path}: {len(calls) - len(parsed)} on(...) call(s) pass an event type "
            f"the scanner cannot read as a literal (line(s): {unreadable}). Register "
            "with a string literal or an array of them, or teach this parser the new "
            "form — an unreadable registration would otherwise read as no handler."
        )

    registrations: list[str] = []
    for match in parsed:
        for index in _STRING_TOKEN_RE.findall(match.group(1)):
            value = literals[int(index)]
            if not _EVENT_NAME_RE.fullmatch(value):
                raise ScanError(
                    f"{ts_path}: on(...) registers {value!r}, which is not a valid event "
                    "type name. Either the call is not a handler registration or the "
                    "event type is computed — both would silently distort the scan."
                )
            registrations.append(value)
    if not registrations:
        raise ScanError(f"{ts_path}: on(...) calls were found but none named an event type.")
    return registrations


# ---------------------------------------------------------------------------
# The ledger and the conformance evaluation.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Waiver:
    """One deliberately-unreconciled event: why, and the issue that removes it."""

    reason: str
    issue: int


@dataclass(frozen=True)
class WaiverLedger:
    """The ratchet. ``unhandled`` is emitted-with-no-handler; ``unemitted`` is the reverse.

    Each budget must equal its dict's length. That is what makes the list
    shrink-only in practice: adding an entry costs a visible ``+1`` on the budget
    line, and deleting one reds the gate until the budget comes down in the same
    MR. The staleness checks in :func:`evaluate` do the other half — a waiver
    whose event has since acquired a handler, or stopped being emitted, fails.
    """

    unhandled: Mapping[str, Waiver]
    unemitted: Mapping[str, Waiver]
    unhandled_budget: int
    unemitted_budget: int


@dataclass(frozen=True)
class Violation:
    kind: str
    subject: str
    detail: str

    def render(self) -> str:
        return f"[{self.kind}] {self.subject}\n    {self.detail}"


def _check_ledger_shape(ledger: WaiverLedger) -> list[Violation]:
    """A waiver with no issue number is a bug waiting to be re-found."""
    violations: list[Violation] = []
    for label, entries in (("unhandled", ledger.unhandled), ("unemitted", ledger.unemitted)):
        for event, waiver in sorted(entries.items()):
            if not waiver.reason.strip():
                violations.append(
                    Violation("waiver-no-reason", event, f"{label} waiver has an empty reason.")
                )
            if waiver.issue <= 0:
                violations.append(
                    Violation(
                        "waiver-no-issue",
                        event,
                        f"{label} waiver cites issue {waiver.issue!r}. Every waiver names the "
                        "issue that removes it; file one if none exists.",
                    )
                )
    for label, entries, budget in (
        ("unhandled", ledger.unhandled, ledger.unhandled_budget),
        ("unemitted", ledger.unemitted, ledger.unemitted_budget),
    ):
        if len(entries) != budget:
            violations.append(
                Violation(
                    "waiver-budget",
                    label,
                    f"{len(entries)} {label} waiver(s) against a budget of {budget}. The budget "
                    "is the ratchet: lower it in the same MR that deletes an entry, and raise "
                    "it deliberately (never silently) to add one.",
                )
            )
    return violations


def evaluate(api_src: pathlib.Path, ts_path: pathlib.Path, ledger: WaiverLedger) -> list[Violation]:
    """Cross-reference emitted event types against registered handlers.

    Returns every violation found, in a stable order. Raises :class:`ScanError`
    if either half inspected nothing.
    """
    emitted = broadcast_event_types_in_source(api_src)
    registrations = handler_registrations_in_source(ts_path)
    handled = set(registrations)

    violations: list[Violation] = []

    # `on()` is last-write-wins: a second registration silently replaces the first.
    seen: set[str] = set()
    for event in registrations:
        if event in seen:
            continue
        if registrations.count(event) > 1:
            seen.add(event)
            violations.append(
                Violation(
                    "duplicate-registration",
                    event,
                    f"registered by {registrations.count(event)} separate on(...) calls. "
                    "Registration is last-write-wins, so every call but the last is dead "
                    "code — fold the handlers into one registration.",
                )
            )

    for event in sorted(emitted - handled - set(ledger.unhandled)):
        violations.append(
            Violation(
                "emitted-no-handler",
                event,
                "broadcast by the API and registered by no on(...) handler. Either wire a "
                "handler in packages/web/src/hooks/useProjectWebSocket.ts, or add an entry "
                "to UNHANDLED_WAIVERS in tests/apps/sync/ws_handler_waivers.py with a reason "
                "and the issue number that removes it.",
            )
        )

    for event in sorted(handled - emitted - set(ledger.unemitted)):
        violations.append(
            Violation(
                "handler-no-emitter",
                event,
                "has an on(...) handler but no broadcast_board_event() call site emits it. "
                "It is dead code unless it arrives by another path (a direct consumer "
                "frame), in which case record it in UNEMITTED_WAIVERS.",
            )
        )

    for event in sorted(ledger.unhandled):
        if event in handled:
            violations.append(
                Violation(
                    "stale-waiver",
                    event,
                    "is waived as unhandled but now HAS a handler. Delete the entry and "
                    "lower UNHANDLED_WAIVER_BUDGET by one — the ledger only shrinks.",
                )
            )
        elif event not in emitted:
            violations.append(
                Violation(
                    "stale-waiver",
                    event,
                    "is waived as unhandled but the API no longer broadcasts it. Delete the "
                    "entry and lower UNHANDLED_WAIVER_BUDGET by one.",
                )
            )

    for event in sorted(ledger.unemitted):
        if event in emitted:
            violations.append(
                Violation(
                    "stale-waiver",
                    event,
                    "is waived as unemitted but the API now broadcasts it. Delete the entry "
                    "and lower UNEMITTED_WAIVER_BUDGET by one.",
                )
            )
        elif event not in handled:
            violations.append(
                Violation(
                    "stale-waiver",
                    event,
                    "is waived as unemitted but nothing registers a handler for it. Delete "
                    "the entry and lower UNEMITTED_WAIVER_BUDGET by one.",
                )
            )

    violations.extend(_check_ledger_shape(ledger))
    return violations
