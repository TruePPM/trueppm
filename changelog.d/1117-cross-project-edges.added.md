- **Cross-project dependencies within a program** (ADR-0120, #1117): a task can now
  depend on a task in a *different project of the same program*. Cross-program edges
  stay rejected (the portfolio boundary is unchanged). Each cross-project edge is
  **consent-gated** — it binds immediately only when the creator can already schedule
  the downstream (successor) project; otherwise it is created pending and a Resource
  Manager on the successor's project accepts or rejects it (`POST /dependencies/{id}/accept`
  and `/reject`). Cycle detection now spans the whole program, and a minimal
  cross-boundary "external task" card (title, project, milestone flag, CPM dates,
  criticality — no private task data) answers "what is blocking me" across a project
  you cannot otherwise open. The program-scoped scheduling pass that makes these edges
  drive a program-true critical path lands in a follow-up slice; until then a
  cross-project edge is a recorded, consented, visible coordination link.
