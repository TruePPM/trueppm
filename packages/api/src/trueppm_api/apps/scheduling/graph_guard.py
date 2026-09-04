"""Reusable dependency-graph validation for bulk / agent-authored task writes.

The human write path (``DependencySerializer._check_no_cycle``) runs
self-reference and cycle detection on every single proposed edge before it is
persisted. Bulk and agent write paths — the MS Project importer, the offline
Jira importer (#1664), the spreadsheet importer, and any future non-interactive
writer — build whole ``Dependency`` graphs with ``bulk_create`` and therefore
**bypass** that gate entirely.

Every importer named above now calls this guard before its write. The seed
importer (``apps/seed/importer.py``) still does not — tracked in #2589.

That gap is benign only while no bulk writer accepts an untrusted graph. The
moment a prospect's messy Jira export can be imported (#1664), a cyclic or
self-referential link would persist an infeasible dependency network that then
crashes the CPM / what-if engine on the imported data. The differentiator's
whole claim is that human and agent principals are governed identically; a
validation gate that only the human path enforces violates "hybrid by
construction."

This module is the shared gate. It wraps the *same* ``trueppm_scheduler``
``find_cycle`` algorithm the serializer uses — so the human and agent paths
detect the identical set of cycles — plus the trivial self-reference identity
check. Callers pass the *complete* edge set they are about to persist (they
already hold it in memory, so no DB round-trip is needed) and run this guard
**before** the write and before ``enqueue_recalculate``.

The guard operates on opaque string node ids, so callers may validate in their
own external-id space (Jira issue keys, MS Project uids) *before* creating any
row — the cycle/self-reference structure is invariant under relabeling, so a bad
graph is rejected before a single task is written.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

from trueppm_scheduler import find_cycle

#: Longest one node label may run in a labelled message before it is elided.
MAX_LABEL_CHARS = 40
#: Most labels rendered along a cycle path; the rest collapse to "… (N more)".
#:
#: A cycle is a *set* of mutually-blocking tasks, so naming three or four of its
#: members and counting the rest identifies the loop as well as listing all of
#: them would — and a 200-task cycle must not produce a 200-name sentence.
MAX_CYCLE_LABELS = 4
#: Hard ceiling the two caps above are chosen to keep the whole sentence under.
#:
#: Not decoration: the classification popover's ``presentable()``
#: (``useClassificationPopover.ts``) *discards* a server message longer than 300
#: characters and shows its generic fallback instead, so an unbounded sentence
#: would silently undo this whole message. Asserted in the guard's tests.
#:
#: **Measured in UTF-16 code units, not code points**, because that is what the
#: check on the other side measures: JavaScript's ``String.length`` counts an
#: astral character (an emoji in a task name — ordinary, not adversarial) as two.
#: A code-point budget would pass here and be discarded there, which is the exact
#: failure this cap exists to prevent.
MAX_MESSAGE_CHARS = 300

#: C0 and C1 control characters, plus DEL.
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _utf16_len(text: str) -> int:
    """Length as JavaScript's ``String.length`` would report it."""
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in text)


def _elide(text: str, limit: int) -> str:
    """Trim ``text`` to at most ``limit`` UTF-16 units, marking the cut with "…".

    Iterates code points, so the cut can never land between the halves of a
    surrogate pair and produce a lone surrogate.
    """
    if _utf16_len(text) <= limit:
        return text
    kept: list[str] = []
    width = 0
    for ch in text:
        char_width = 2 if ord(ch) > 0xFFFF else 1
        if width + char_width > limit - 1:
            break
        kept.append(ch)
        width += char_width
    return "".join(kept).rstrip() + "…"


def _labelled(node: str, labels: Mapping[str, str]) -> str:
    """A node's human label, falling back to its raw id when it has none.

    A per-node fallback rather than an all-or-nothing one: a cycle whose members
    are mostly resolvable is still worth naming, and a row deleted between the
    refusal and the lookup must not cost the caller the other names.

    Control characters are dropped and whitespace collapsed first. A label is
    built from a task name, which is caller-controlled text that ``CharField``
    does not stop from holding a newline, a tab, or an ANSI escape — and this
    string is now *prose*, which a CLI or agent client is far likelier to print
    raw than a JSON field. A name carrying its own line breaks could otherwise
    fake the end of the message and append a sentence of its own.
    """
    printable = _CONTROL_CHARS.sub(" ", labels.get(node, node))
    return _elide(" ".join(printable.split()), MAX_LABEL_CHARS)


def nodes_to_label(offending: list[str]) -> list[str]:
    """The node ids a labelled message will actually name.

    Exposed so a caller can resolve *only* the ids it is going to print. A cycle
    is capped at :data:`MAX_CYCLE_LABELS` names, so resolving all of a 5000-task
    loop would materialize 5000 rows to render four.

    Deliberately lives beside :func:`_render_cycle` rather than being reproduced
    at the call site: the two have to agree about which positions survive the
    elision, and a caller re-deriving that slice locally is how they drift apart.
    """
    if len(offending) <= MAX_CYCLE_LABELS:
        return list(offending)
    return [*offending[: MAX_CYCLE_LABELS - 1], offending[-1]]


def _render_cycle(offending: list[str], labels: Mapping[str, str]) -> str:
    """The cycle path as an arrow chain, elided in the middle when it is long.

    ``find_cycle`` repeats the first node at the end, and that repetition is what
    makes the sentence read as a loop — so the last element is always kept and
    the elision is taken out of the middle.
    """
    if len(offending) <= MAX_CYCLE_LABELS:
        return " → ".join(_labelled(node, labels) for node in offending)
    head = offending[: MAX_CYCLE_LABELS - 1]
    hidden = len(offending) - MAX_CYCLE_LABELS
    parts = [_labelled(node, labels) for node in head]
    parts.append(f"… ({hidden} more)")
    parts.append(_labelled(offending[-1], labels))
    return " → ".join(parts)


def _build_message(reason: str, offending: list[str], labels: Mapping[str, str] | None) -> str:
    """The exception's message, human-facing when the caller supplied labels.

    Without labels the original domain-signal message is kept verbatim. That is
    what the importers validate in — they run the guard in their own external-id
    space (Jira keys, MS Project uids) *before* any row exists, so there is no
    task to name yet, and each already renders its own sentence from ``reason``
    and ``offending`` (``msproject.importer.describe_bad_graph``).

    Both branches tolerate an empty ``offending``. Neither is reachable from
    :func:`validate_task_graph`, which always blames at least one node — but the
    message builder must not be the thing that turns a refusal into a 500, or a
    dangling separator, if a later caller constructs one.
    """
    if labels is None:
        return f"Infeasible task graph ({reason}): {offending}"
    if reason == "self_reference":
        node = _labelled(offending[0], labels) if offending else "A task"
        return (
            f"Task {node} lists itself as its own predecessor. "
            "Remove that link to schedule this plan."
        )
    named = _render_cycle(offending, labels) if offending else "these tasks"
    return f"Circular dependency: {named}. Remove one of those links to schedule this plan."


class InfeasibleGraphError(Exception):
    """A proposed task-dependency graph cannot be persisted.

    Deliberately not a DRF ``ValidationError``: this is a domain signal raised
    from service / importer code that has no request context. Callers translate
    it to whatever their surface needs — an importer marks its outbox row DEAD
    and records the reason on the TaskRunTracker; a view would map it to a 400.

    Attributes:
        reason: A stable machine code — ``"self_reference"`` or
            ``"cyclic_dependency"`` — so callers can branch (quarantine a
            self-loop vs. reject a whole import) without string-matching the
            message.
        offending: The node ids implicated. For ``"self_reference"`` the single
            offending node; for ``"cyclic_dependency"`` the ordered cycle path
            (first id repeated at the end, e.g. ``["A", "B", "A"]``), matching
            :func:`trueppm_scheduler.find_cycle`.
        labels: ``{node_id: human label}`` when a caller has resolved the ids to
            something the person reading the refusal can find in their plan, or
            ``None`` when the message is still in id space. Only the *message*
            reads this — ``offending`` stays the raw id list either way, because
            that is what a client branches or highlights rows on.
    """

    def __init__(
        self,
        reason: str,
        offending: list[str],
        *,
        labels: Mapping[str, str] | None = None,
    ) -> None:
        self.reason = reason
        self.offending = offending
        self.labels: dict[str, str] | None = dict(labels) if labels is not None else None
        super().__init__(_build_message(reason, offending, self.labels))

    def with_labels(self, labels: Mapping[str, str]) -> InfeasibleGraphError:
        """This same refusal, re-worded to name its nodes rather than list their ids.

        Returns a new instance rather than mutating in place so the raised object
        stays immutable and the original stays available as the ``__cause__`` of
        whatever the caller re-raises.

        The guard itself operates on opaque node ids and cannot resolve them, so
        labelling belongs to the caller that knows the id space. Doing it *after*
        the refusal rather than passing labels in is deliberate: only the ids the
        guard actually blamed need resolving, and the feasible path — every
        request that is not refused — pays nothing at all.
        """
        return InfeasibleGraphError(self.reason, self.offending, labels=labels)


def validate_task_graph(
    edges: list[tuple[str, str]],
    *,
    children_map: dict[str, list[str]] | None = None,
) -> None:
    """Reject a self-referential or cyclic dependency graph before it is written.

    Runs the same self-reference and :func:`trueppm_scheduler.find_cycle` checks
    the interactive ``DependencySerializer`` path runs, so bulk / agent writers
    are governed identically to the human write path.

    Args:
        edges: The complete ``(predecessor_id, successor_id)`` set the caller is
            about to persist, as opaque string node ids. Callers that want to
            validate before minting DB rows may pass their external-id space
            (e.g. Jira issue keys) — cycle/self-reference detection is invariant
            under relabeling.
        children_map: Optional ``{summary_id: [child_id, ...]}`` mapping so that
            summary→leaf logical cycles are expanded and caught, matching the
            serializer's summary handling. Omit (``None``) for flat graphs with
            no summary tasks (the minimal-import case), where direct edge cycle
            detection is sufficient.

    Raises:
        InfeasibleGraphError: With ``reason="self_reference"`` if any edge links
            a task to itself, or ``reason="cyclic_dependency"`` if the graph
            contains a cycle. The message and ``offending`` path let the caller
            surface an actionable error rather than crash the CPM engine.
        InvalidScheduleInput: Re-raised unchanged if the graph is *malformed*
            (a pathological summary fan-out beyond the engine's cap, or a
            children_map that is itself cyclic) — a distinct failure from a
            cycle in the edges. Callers treat it the same as a rejection.
    """
    # Self-reference is a cheap identity check that also gives the caller a
    # precise offending node (find_cycle would report it as a length-1 loop,
    # but a dedicated code lets importers *quarantine* a self-loop — skip it
    # with a warning — rather than reject the whole import).
    for predecessor, successor in edges:
        if predecessor == successor:
            raise InfeasibleGraphError("self_reference", [predecessor])

    result = find_cycle(edges, children_map=children_map)
    if result.cycle is not None:
        raise InfeasibleGraphError("cyclic_dependency", result.cycle)
