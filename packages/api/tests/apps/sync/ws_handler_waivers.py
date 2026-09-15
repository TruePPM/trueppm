"""The WS event/handler drift ledger: every event the two halves still disagree on (#3775).

Read this as a ledger, not as an exemption list. ``scripts/check-ws-handler-conformance.sh``
fails on every emitted event NOT listed here, and on every handler whose event nothing
emits. These thirteen entries are what is left.

Be honest about what a waiver buys. Like ``--update-baseline`` on the docs gate and
``e2e/fixtures/schema-guard-waivers.ts``, it cannot stop a wrong answer — a wrong entry
gets today's outcome. What it removes is the **silence**: before this gate, an event
broadcast to nobody generated no signal anywhere in the pipeline, which is why three
separate audits (#2847, #3245, the 0.4 pre-release pass) each re-found a different slice
of the same class and none could have found the others'.

## Shape

    'event_name': Waiver(reason='why, and what removes it', issue=1234),

* ``UNHANDLED_WAIVERS`` — the API broadcasts it and no ``on(...)`` handler registers it.
* ``UNEMITTED_WAIVERS`` — an ``on(...)`` handler registers it and no
  ``broadcast_board_event()`` call site emits it.
* Every entry names a **real** issue, and the gate rejects one that does not — a waiver
  with no issue is a bug waiting to be re-found. For a gap, that is the **open** issue
  that closes it (#2847, #3245, #836). For the two entries that are decisions rather than
  gaps, it is the **closed** issue where the decision was made (#1323, #321); there is
  nothing to fix, and filing a "fix this" issue to satisfy the field would be a lie about
  the tracker. Which kind an entry is, is what its reason says.
* Each budget equals its dict's length, and that is the ratchet. Deleting an entry reds
  the gate until the budget drops in the same MR; adding one costs a visible ``+1`` on a
  line a reviewer reads. The gate's own staleness checks do the other half — a waiver for
  an event that has since acquired a handler, or stopped being broadcast, fails.

## Seeding this ledger is NOT the same as reviewing these events

#3775 built the gate. It deliberately wrote no handlers: every entry below was already
broken before the gate existed and keeps its own tracking issue. Do not read a waiver as
a decision that the event should stay unhandled — except ``task_duration_changed``, which
genuinely is one.

## The four clusters, and which side is wrong

**(a) FRONTEND MISSING — #2847.** ``label_*``, ``sprint_reranked`` and ``project_restored``
are correctly broadcast, on commit, and live in ``FROZEN_WS_EVENT_TYPES``; nothing in
``packages/web/src`` names them. This is the cluster that named the class.

**(b) FRONTEND MISSING — #3245.** ``project_calendar_changed`` carries the actor label
#3174 built and no client subscribes to it. Same shape as (a), found by a different audit
that was not looking for (a)'s findings.

**(c) STRUCTURALLY UNDELIVERABLE — #836.** The five ``program_*`` events fan out on the
channel group ``project_{program_id}``. There is no ``ws/v1/programs/`` route and
``ProjectConsumer`` resolves membership against ``ProjectMembership``, which a Program
UUID never matches — so neither ``group_add()`` call site in the codebase can produce that
group. A handler for these would be unreachable code, not a fix; the channel has to ship
first (0.8). ``scripts/check-ws-event-reachability.sh`` owns the documentation half of the
same defect, and inverts on the same event when the route lands.

**(d) DELIBERATE — #1323.** ``task_duration_changed`` is the one entry that is a decision
rather than a gap, and the hook says so at its registration site: the duration delta
already arrives on the ``task_updated`` broadcast in the same commit batch, *with*
ADR-0152 self-echo suppression. Re-invalidating here — the event carries no ``actor_id``
to suppress on — would clobber the editing client's in-flight optimistic edit, which is
the exact regression ADR-0152 exists to prevent.

And on the reverse side, ``resync_required`` (#321/ADR-0236) is emitted by
``ProjectConsumer`` as a direct frame on the replay path, never through
``broadcast_board_event()``, so it is a handler the emitter scan structurally cannot see
— not dead code.
"""

from __future__ import annotations

from .ws_event_scan import Waiver, WaiverLedger

# --- (a) #2847 · (b) #3245 · (c) #836 · (d) #1323 ---
UNHANDLED_WAIVERS = {
    "label_created": Waiver(
        reason="No frontend consumer anywhere in packages/web/src; project label CRUD does "
        "not reach a peer's open board until a manual refetch.",
        issue=2847,
    ),
    "label_updated": Waiver(
        reason="No frontend consumer anywhere in packages/web/src; a renamed or recolored "
        "label keeps its old chip on a peer's board.",
        issue=2847,
    ),
    "label_deleted": Waiver(
        reason="No frontend consumer anywhere in packages/web/src; a deleted label keeps "
        "rendering on a peer's board.",
        issue=2847,
    ),
    "sprint_reranked": Waiver(
        reason="No frontend consumer; a peer's sprint backlog keeps the pre-rerank order "
        "until it refetches for another reason.",
        issue=2847,
    ),
    "project_restored": Waiver(
        reason="No frontend consumer; a project restored from Trash does not reappear in a "
        "peer's project list live (ADR-0202).",
        issue=2847,
    ),
    "project_calendar_changed": Waiver(
        reason="No client subscribes, so the actor label #3174 added to the payload reaches "
        "nobody and a calendar swap does not move a peer's schedule live.",
        issue=3245,
    ),
    "program_closed": Waiver(
        reason="Undeliverable, not unhandled: fans out on project_{program_id}, and no "
        "ws/v1/programs/ route exists for any group_add() to join. A handler would be "
        "unreachable until the program channel ships.",
        issue=836,
    ),
    "program_reopened": Waiver(
        reason="Undeliverable — program-group fan-out with no program WS route (see "
        "program_closed).",
        issue=836,
    ),
    "program_deleted": Waiver(
        reason="Undeliverable — program-group fan-out with no program WS route (see "
        "program_closed).",
        issue=836,
    ),
    "program_split": Waiver(
        reason="Undeliverable — program-group fan-out with no program WS route (see "
        "program_closed).",
        issue=836,
    ),
    "program_sponsorship_transferred": Waiver(
        reason="Undeliverable — program-group fan-out with no program WS route (see "
        "program_closed).",
        issue=836,
    ),
    "task_duration_changed": Waiver(
        reason="DELIBERATE (ADR-0151/ADR-0152). The duration delta already arrives on the "
        "task_updated broadcast in the same commit batch, with self-echo suppression. This "
        "event carries no actor_id, so a handler here would clobber the editing client's "
        "in-flight optimistic edit. Its extra payload is the inline 'Recalc %?' hint, "
        "consumed locally by the editing client.",
        issue=1323,
    ),
}

UNEMITTED_WAIVERS = {
    "resync_required": Waiver(
        reason="Not dead code: ProjectConsumer sends this frame directly on the replay path "
        "(consumers.py, ADR-0236) when the requested ?since= predates the retained window. "
        "It never goes through broadcast_board_event(), so the emitter AST sweep "
        "structurally cannot see it.",
        issue=321,
    ),
}

# The ratchet. Each must equal its dict's length; see the module docstring.
UNHANDLED_WAIVER_BUDGET = 12
UNEMITTED_WAIVER_BUDGET = 1

LEDGER = WaiverLedger(
    unhandled=UNHANDLED_WAIVERS,
    unemitted=UNEMITTED_WAIVERS,
    unhandled_budget=UNHANDLED_WAIVER_BUDGET,
    unemitted_budget=UNEMITTED_WAIVER_BUDGET,
)
