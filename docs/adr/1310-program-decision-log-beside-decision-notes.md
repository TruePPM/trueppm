# ADR-1310: The program decision log is a new entity, beside decision-flagged notes

## Status
Accepted (2026-10-31). Issue #4772, epic #1163. Consumed by #4769 (PM home focus
card) and #4771 (Executive home).

## Context

Pass 1's PM and Executive homes show the decisions a program is **waiting on**, each
with an owner and the owner's impact estimate ("recovers 2 days · P80 back to Dec 5").
The server holds no such fact, so neither home can show one without inventing it in
the client.

TruePPM already has something called "Decisions": a task note flagged as a decision
(ADR-0167), collected into the project Decisions view under Reports. Before adding
anything, we had to choose whether the new record extends that one or sits beside it.

The two answer different questions:

| | Decision-flagged note (ADR-0167) | Program decision (this ADR) |
|---|---|---|
| Tense | Retrospective: "we decided X" | Prospective: "we must decide X by Friday" |
| Scope | Project, grouped by sprint | Program |
| Owner / due date / open state | None | Required to be useful |
| Anchor | Always a task (it *is* a note on a task) | Optional task **or** risk |
| Visibility gate | Team-owned oversight consent (ADR-0167 §3) | Program RBAC |

Extending `TaskNote` would mean adding owner, due date, status and a risk link to every
note, making the program a derived scope over notes that belong to project tasks, and
reconciling two visibility models on one row. It would also force every awaiting
decision to hang off a task, which is not how a program states an open question.

## Decision

1. **A new model, `ProgramDecision`, sits beside the decision-flagged note.** Neither
   feeds the other. The model is named `ProgramDecision` (not `Decision`) and its route
   is `/programs/{id}/decisions/`, so the two features never share a symbol even though
   they share a word.
2. **`impact_note` is the owner's free text and is never presented as a forecast.**
   The server stores it verbatim. Every surface renders it with its provenance,
   "Owner's estimate · as of `updated_at`", in body type, never in the figure styling
   used for P50/P80. A computed impact (linked item against the live P80) is a
   separate server fact with its own provenance (#4773). It is not a parse of this
   field.
3. **Status is a small state machine:** `awaiting → made | withdrawn`, and
   `made | withdrawn → awaiting` (reopen). `made → withdrawn` is refused: rewriting a
   made call needs the reopen that explains it. `decided_at` is server-stamped on the
   move to `made` and cleared on reopen.
4. **Links stay inside the program, and inside what the writer can read.** A linked
   task or risk must belong to a live project in the same program (an id outside it
   reads as "does not exist", the same as a random UUID), and the writer must be a
   member of that project. At most one of task or risk is set (a DB check constraint).
   A reader outside the linked project sees that a link exists, but not its title
   (ADR-0120 D5: program membership admits, project membership reveals).
5. **RBAC:** Viewer reads; Team Member and up write; Program Manager and up delete;
   closed programs are read-only. Delete is one tier above edit because the log is a
   record, and withdrawing is the member's way to take a decision off it.
6. **No live broadcast and no sync participation.** Program-scoped rows have no program
   channel group to fan out on (`routing.py`) and sit outside the project sync union,
   like `BacklogItem`.

## Consequences

- The program homes (#4769, #4771) can read `?status=awaiting` as a server fact.
- The legacy rail does not list the page. It is reachable from shell v2's **More** and
  by URL.
- MCP read exposure is deliberately not part of this change. Adding the viewset to
  `McpReadableViewMixin` needs an `McpScope` choice for a program-scoped row that
  carries project links. Tracked in #4774.
- The workspace backup archive includes the decision log (`programs/decisions.json`).
  The program seed export does not yet: the seed v2 schema rejects unknown keys, so
  adding decisions needs a schema minor (2.2) with validation and import. Tracked in
  #4776.
- Writes are reachable by a `legacy:full` personal access token, the same as
  `backlog-items/` (recorded in `token_write_surface.txt`). An `mcp:read` agent token
  gets a 401 here: the view is not MCP-wrapped, so `OwnerScopedApiTokenAuthentication`
  admits only `legacy:full` personal tokens.
