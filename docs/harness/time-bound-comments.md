# Time-bound comment gate (`scripts/check-time-bound-comments.py`, #4399)

Five comments asserted facts a later change made false ("Stub -- used by a future viewset",
"As of this writing 0009 is UNRELEASED"). Nothing re-checks a claim about time, so it outlives the fact.

Under `packages/*/src` (`.py .ts .tsx .js .rs`), a line containing `UNRELEASED` (uppercase),
`Stub --`/`Stub —`, `future ... viewset`, or `as of this writing` fails unless that line or
one of the two above carries `TODO(#NNN)` (policed by `lint:todo-grep`) or
`time-bound-ok: <reason>`.

Run it with `make time-bound-comments-check` (part of `make pre-push`; CI job
`api:time-bound-comments`). Both run `--self-test` first, which pins that a reintroduced
"As of this writing ... UNRELEASED" fails and that anchored or plain text passes.

Limits: an opt-out is a rubber stamp that removes the silence, not the chance of a wrong
answer. It is a phrase grep: a stale claim worded differently is invisible to it.
