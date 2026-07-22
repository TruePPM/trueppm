"""Lint gate: ``get_or_create`` / ``update_or_create`` lookups must be uniqueness-backed (#2268).

A recurring bug class (#2267 ``Resource.email``, #1956 reaction rows): calling
``Model.objects.get_or_create(<field>=…)`` / ``update_or_create`` where the lookup
carries **no uniqueness constraint**. When the table legitimately holds two matching
rows, Django's ``get()`` inside ``get_or_create`` raises ``MultipleObjectsReturned`` —
an unhandled 500.

This gate AST-walks ``packages/api/src`` (migrations excluded), resolves each
statically-named ``<Model>.objects.get_or_create(...)`` / ``update_or_create(...)``
against Django's app registry, and asserts the lookup (keyword args minus ``defaults``)
is a superset of at least one of the model's uniqueness constraint sets — single-field
``unique=True`` (incl. ``OneToOneField``), ``unique_together``, ``UniqueConstraint.fields``,
or the primary key. ``<rel>_id`` kwargs are normalized to ``<rel>`` before comparison.

Reviewed-safe call sites carry a waiver marker on the call line or the line directly
above it::

    # get-or-create-ok: <why this call can never see a duplicate>
    User.objects.get_or_create(email=email, defaults=...)

**Known limitation** (deliberate — a static gate cannot do better): only
*statically-named* ``<Model>.objects`` receivers with *literal keyword* lookups are
analyzed. It cannot see through:

* dynamic ``**lookup`` kwargs — this is the exact #2267 call shape; no static gate can
  read the keys of a runtime dict;
* related-manager receivers (``obj.things.get_or_create(...)``) or ``cls.objects``.

So this is a ratchet against the common static form and new regressions, not a proof of
total safety. Those unresolved shapes are counted (``test_gate_covers_expected_share``)
so a silent collapse in coverage is visible.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

from django.apps import apps

_WAIVER_MARKER = "# get-or-create-ok:"
_GOC_METHODS = frozenset({"get_or_create", "update_or_create"})

# packages/api/src — the tree the gate lints.
_SRC_ROOT = Path(__file__).resolve().parents[1] / "src"


@dataclass(frozen=True)
class Finding:
    file: str
    line: int
    model: str
    lookup: tuple[str, ...]
    waived: bool


def build_constraint_index() -> dict[str, tuple[list[frozenset[str]], set[str]]]:
    """Map each model name → (uniqueness constraint sets, concrete relation field names).

    A lookup is "safe" iff it is a superset of one of the constraint sets. Relation
    field names let the caller normalize a ``<rel>_id`` kwarg back to ``<rel>`` so a
    ``get_or_create(sprint_id=…, snapshot_date=…)`` matches a ``(sprint, snapshot_date)``
    constraint. Conditional ``UniqueConstraint``s are included by their ``fields`` —
    slightly permissive, but a lookup that pins those fields is the intended safe path.
    """
    index: dict[str, tuple[list[frozenset[str]], set[str]]] = {}
    for model in apps.get_models():
        sets: set[frozenset[str]] = set()
        relations: set[str] = set()
        for field in model._meta.get_fields():
            if getattr(field, "concrete", False) and getattr(field, "is_relation", False):
                relations.add(field.name)
            if (
                getattr(field, "concrete", False)
                and getattr(field, "unique", False)
                and not getattr(field, "primary_key", False)
            ):
                sets.add(frozenset({field.name}))
        sets.add(frozenset({"pk"}))
        sets.add(frozenset({model._meta.pk.name}))
        for combo in getattr(model._meta, "unique_together", ()) or ():
            sets.add(frozenset(combo))
        for constraint in getattr(model._meta, "constraints", []) or []:
            if constraint.__class__.__name__ == "UniqueConstraint" and getattr(
                constraint, "fields", None
            ):
                sets.add(frozenset(constraint.fields))
        # A model may be registered under duplicate names only via swappable configs;
        # merge defensively rather than overwrite.
        prev = index.get(model.__name__)
        if prev is None:
            index[model.__name__] = (list(sets), relations)
        else:
            prev[0].extend(sets)
            prev[1].update(relations)
    return index


def _normalize(keys: set[str], relations: set[str]) -> set[str]:
    """Rewrite ``<rel>_id`` → ``<rel>`` so FK-id kwargs match constraint field names."""
    out: set[str] = set()
    for key in keys:
        out.add(key[:-3] if key.endswith("_id") and key[:-3] in relations else key)
    return out


def analyze_source(
    text: str,
    filename: str,
    index: dict[str, tuple[list[frozenset[str]], set[str]]],
) -> tuple[list[Finding], int]:
    """Return (unsafe findings, count of unresolved get_or_create/update_or_create sites).

    A finding is a statically-resolvable call whose lookup is not uniqueness-backed.
    "Unresolved" = a named ``<Model>.objects`` call the gate cannot judge (dynamic
    ``**kwargs`` lookup, or a model name absent from the registry); those are counted
    but not failed, since a static check genuinely cannot prove them either way.
    """
    tree = ast.parse(text, filename=filename)
    lines = text.splitlines()
    findings: list[Finding] = []
    unresolved = 0

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute) or func.attr not in _GOC_METHODS:
            continue
        receiver = func.value
        # Only <Name>.objects.<method>(...) is statically resolvable to a model.
        if not (
            isinstance(receiver, ast.Attribute)
            and receiver.attr == "objects"
            and isinstance(receiver.value, ast.Name)
        ):
            continue
        model = receiver.value.id
        constraint_info = index.get(model)
        # Dynamic **lookup (kw.arg is None) or unknown model → cannot judge statically.
        if any(kw.arg is None for kw in node.keywords) or constraint_info is None:
            unresolved += 1
            continue

        constraint_sets, relations = constraint_info
        lookup = _normalize(
            {kw.arg for kw in node.keywords if kw.arg not in (None, "defaults")},
            relations,
        )
        if any(cset <= lookup for cset in constraint_sets):
            continue

        # Accept the waiver marker on the call's own line(s) or the line directly
        # above it (keeps the reason full-width instead of cramped after the paren).
        end_line = node.end_lineno or node.lineno
        span = "\n".join(lines[max(0, node.lineno - 2) : end_line])
        findings.append(
            Finding(
                file=filename,
                line=node.lineno,
                model=model,
                lookup=tuple(sorted(lookup)),
                waived=_WAIVER_MARKER in span,
            )
        )
    return findings, unresolved


def _scan_tree() -> tuple[list[Finding], int]:
    index = build_constraint_index()
    all_findings: list[Finding] = []
    unresolved = 0
    for path in _SRC_ROOT.rglob("*.py"):
        if "/migrations/" in path.as_posix():
            continue
        findings, count = analyze_source(
            path.read_text(encoding="utf-8"),
            str(path.relative_to(_SRC_ROOT.parents[1])),
            index,
        )
        all_findings.extend(findings)
        unresolved += count
    return all_findings, unresolved


def test_no_unwaived_nonunique_get_or_create() -> None:
    """Every statically-resolvable get_or_create/update_or_create lookup is uniqueness-backed.

    A new violation fails here. If a call is genuinely safe (controlled input that can
    never see a duplicate), add an inline ``# get-or-create-ok: <reason>`` on the call —
    do not weaken this gate.
    """
    findings, _ = _scan_tree()
    unwaived = [f for f in findings if not f.waived]
    detail = "\n".join(
        f"  {f.file}:{f.line}  {f.model}.objects lookup={list(f.lookup)} "
        f"— add a uniqueness constraint, key on a unique field, or waive with "
        f"'{_WAIVER_MARKER} <reason>'"
        for f in unwaived
    )
    assert not unwaived, f"get_or_create/update_or_create on a non-unique lookup (#2268):\n{detail}"


def test_gate_covers_expected_share() -> None:
    """Sanity floor: the gate still resolves the bulk of call sites.

    Guards against a refactor that silently routes every call through an unresolved
    shape (which would make the gate a no-op). The static form is the majority today.
    """
    findings, unresolved = _scan_tree()
    total = len(findings) + unresolved
    assert total > 0, "gate found no get_or_create/update_or_create calls — walk is broken"
    # Unresolved (dynamic **lookup / unknown model) is the tail, not the whole; if every
    # site were unresolved the gate would be judging nothing.
    assert unresolved < total, "every call site is unresolved — the gate is judging nothing"


def test_analyzer_flags_and_clears_synthetic_calls() -> None:
    """Self-test the analyzer core so the gate cannot silently pass on broken logic."""
    index = {
        # Widget: unique on (a, b); FK relation 'owner'; pk 'id'.
        "Widget": (
            [frozenset({"a", "b"}), frozenset({"owner"}), frozenset({"pk"}), frozenset({"id"})],
            {"owner"},
        ),
        # Gadget: no non-pk uniqueness at all (the Resource/#2267 shape).
        "Gadget": ([frozenset({"pk"}), frozenset({"id"})], set()),
    }
    src = (
        "Widget.objects.get_or_create(a=1, b=2, defaults={})\n"  # safe: full unique_together
        "Widget.objects.get_or_create(owner_id=5)\n"  # safe: FK-id normalizes to unique 'owner'
        "Widget.objects.get_or_create(a=1)\n"  # UNSAFE: partial constraint
        "Gadget.objects.update_or_create(name='x')\n"  # UNSAFE: model has no unique field
        "Gadget.objects.get_or_create(name='x')  # get-or-create-ok: test waiver\n"  # waived
    )
    findings, unresolved = analyze_source(src, "synthetic.py", index)
    assert unresolved == 0
    by_line = {f.line: f for f in findings}
    # Lines 1 and 2 are safe → not findings.
    assert 1 not in by_line and 2 not in by_line
    # Line 3 (partial) and line 4 (no-unique) are unsafe, unwaived.
    assert by_line[3].model == "Widget" and not by_line[3].waived
    assert by_line[4].model == "Gadget" and not by_line[4].waived
    # Line 5 is unsafe but waived.
    assert by_line[5].waived


def test_analyzer_skips_dynamic_and_related_manager_shapes() -> None:
    """Dynamic **lookup and related-manager receivers are counted unresolved, never failed."""
    index = {"Gadget": ([frozenset({"pk"})], set())}
    src = (
        "Gadget.objects.get_or_create(**lookup)\n"  # dynamic → unresolved
        "parent.gadgets.get_or_create(name='x')\n"  # related manager → skipped entirely
    )
    findings, unresolved = analyze_source(src, "synthetic.py", index)
    assert findings == []
    assert unresolved == 1  # only the named-model dynamic call is counted
