# `transaction.on_commit` durability (`lint:on-commit-durability`)

**Rule (#2473, from #659).** A `transaction.on_commit` callback may dispatch Celery work
only behind a committed outbox row (a PENDING row a Beat drain replays), and may otherwise
only call best-effort primitives whose loss is recoverable (WebSocket broadcasts). The
rationale and rubric live in `docs/durability/on-commit-audit.md`; this gate enforces them.

## The gate

`scripts/check-on-commit-durability.py` (CI job `lint:on-commit-durability`, `make
on-commit-durability-check`, part of `make pre-push`) parses `packages/api/src/trueppm_api`
with `ast`, expands each callback (lambda, `functools.partial`, or a same-file `def`, four
levels deep) into the call names it reaches, and assigns one class: `outbox`,
`best-effort`, `hole` (dispatches Celery with no registered outbox helper reachable from
the callback or called in the enclosing function) or `unclassified` (calls something the
registry does not know). It runs its `--self-test` first, which plants a hole and requires
the gate to fail on it, and proves the docs-drift check trips on a changed registry.

## Registry and baseline

* `packages/api/on-commit-registry.txt`: outbox helpers (with model and drain task),
  best-effort primitives (with why a loss is acceptable) and benign calls. The audit doc's
  table is generated from it; the gate fails if the doc drifts (`--write-docs` fixes it).
* `packages/api/on-commit-baseline.txt`: `path | class | max-count | issue | reason`. A
  ceiling: a count above fails (new callsite), below fails until you lower it, an entry
  matching nothing fails. `hole`/`unclassified` only. The gate also compares the file with
  its merge-base copy (`git show origin/main:...`, or `CI_MERGE_REQUEST_DIFF_BASE_SHA` in
  CI) and fails a raised count or a new entry unless the entry has `# raise-ok: <reason>`
  on the line above, honored only while new relative to the base. That marker is a
  self-grant in the file it guards; the reviewer reading the diff is the control. The
  comparison is skipped with a note when no merge base exists (no `origin/main`, or on
  `main`); a named but unreachable base ref fails closed. Baselined sites are tracked in #5082.
* `# on-commit-ok: <reason>` on the line or the comment line above opts one callsite out
  (reason required). A rubber stamp that removes the silence, like `# layering-ok:`.

## What it does NOT see

* Helpers imported from another module are not expanded; a `.delay()` hidden in one is
  invisible, and only its name is looked up in the registry.
* A registered helper is trusted to write its row first; a registered best-effort name is
  trusted to be loss-tolerant. The gate does not verify either.
* "Enclosing function calls an outbox helper" is proximity, not data flow.
* Aliased or dynamic callsites (`cb = on_commit`, `getattr`) are not found. A callback
  that is an expression the gate cannot expand (subscript, call result) is `unclassified`.
* Tests, enterprise code and `migrations/` are not scanned. Same-name nested defs collapse.
* Baselined callsites are *not* proven safe: some are read and row-backed (the reason says
  so), the rest are not yet audited. `--report` lists them.

## When it fails

1. Dispatching Celery? Write an outbox row through a registered helper first, or register a
   new helper (model + drain) in the registry.
2. Calling a new broadcast-like primitive? Register it as `best-effort` with the reason.
3. Genuinely safe? `# on-commit-ok: <reason>`. Last resort: a baseline entry naming an issue.
   Do not raise an existing count to get green.
