# ADR-1340: The MR cost ledger is one setting — on by default, a committed project value, a local opt-out

## Status
Accepted (2026-11-07, #4859). The tooling shipped in #4843 and #4844; this record states the
decision they implemented and the corrections #4859 made to them.

## Context

`/kaizen` measures which gates earn their slot from the `gate:` lines in each MR's `## Gates`
section, but it had no way to see what a gate or a rework round *cost*. The agent harness this
repository's `/wave` and `/mr` skills came from already recorded that: measured token lines in
`## Gates` and a readable `## Cost of this MR` comment on the MR. (Provenance: the harness is the
`macrodream/blueprint` template, ADR 0011 there; the mechanism was ported, adapted, and its
references to that repository removed.)

Recording is not free of judgment. `orchestrator-tokens:` reads the orchestrating session's
transcript, which holds the conversation, to sum its usage fields. A contributor may not want a
tool reading transcripts at all, even for counts, and may not want per-MR usage in a public MR
description. So recording has to be something a project, and one person, can turn off.

Two facts about the inputs shape the design:

- **Transcripts are an undocumented, expiring interface.** Claude Code keeps them under
  `~/.claude/projects/<slug>/` (or `$CLAUDE_CONFIG_DIR/projects/`), lays subagents out as
  `<session-id>/subagents/agent-<id>.jsonl` with a sibling `.meta.json`, and deletes them after
  30 days. The `<slug>` is derived from the directory a session was started in, so a session
  started in a `scripts/wt` worktree lands under a different slug from one started in the main
  checkout.
- **Prices change and model IDs come and go.** A dollar figure computed from a stale or
  incomplete table would read as a fact.

## Decision

**One setting, `cost-ledger`, on by default, turns every cost line and every cost record off or
on together.**

- **Project layer.** `.claude/cost-ledger.json`, committed:
  `{"_doc": ..., "schema": 1, "cost-ledger": "on"}`. Values `on` and `off`; an unknown schema,
  any other value or invalid JSON makes it unreadable. It changes through a chore MR.
- **Local layer, an opt-out only.** `git config trueppm.costLedger false`, read from the local and
  the global config. Local git config lives in the git common dir, so one opt-out covers every
  `scripts/wt` worktree of the clone and is never committed. `scripts/cost-ledger on --local`
  only unsets the key; it never writes `true`.
- **Precedence.** Off if the project file says off; otherwise off if `trueppm.costLedger` is
  false (local or global); otherwise on. A local setting can turn recording off, never on over a
  project that chose off. An unreadable layer counts as off.
- **One reader.** `scripts/cost-ledger` (stdlib Python) is the only code that reads either layer.
  `status [--json]` names the layer that decided; `enabled` exits 0 on, 1 off, 2 unreadable, and
  is what skills and scripts consult; `on|off [--local]` writes a layer.
- **What off means.** `/mr` and `/wave` write the single line `cost-ledger: off` and no cost
  line, run no measuring script, and post no cost comment. Every measuring script and
  `scripts/cost-table.py` also asks the reader first and exits 3 without opening a transcript
  (defense in depth). The marker names no layer, so a public MR never reveals one person's
  opt-out. `budget-exceeded:` is not a cost line and is written either way.
- **Measured lines stay measured.** `subagent-tokens:` and `orchestrator-tokens:` are sums of
  per-response usage, once per message id, from the transcripts. A figure that cannot be measured
  (missing transcript, ambiguous session, layout change) is omitted, never written as 0. A
  window in which no subagent ran is a measured 0 only through the explicit `--no-agents` flag;
  a forgotten `--agent` exits 2.
- **The estimate is its own line.** `est-cost-usd: <N.NN> (prices YYYY-MM-DD)` is a list-price
  equivalent from `.claude/model-prices.json`, never what a subscription charged. Rows are keyed
  by exact model ID with no family fallback. A missing row, a table over 90 days old, or a
  response in a mode the table has no multiplier for omits the whole line with a `## Notes`
  reason, never a partial or zero price.
- **Transcripts are found by session id, never by slug.** Every reader globs
  `<projects-dir>/*/<session-id>` and needs exactly one hit, so a worktree session and a
  main-checkout session are both found, and an ambiguous id fails closed.
- **The readable table is an MR comment.** `scripts/cost-table.py` renders
  `## Cost of this MR (#<issue>)` with a per-family (Sonnet, Opus, Other) split. Later work on the
  MR posts numbered records with a running total; an earlier record is never edited, and earlier
  records are read back only from the token user's own notes that parse strictly.

## Consequences

- Recording is a choice a contributor can reverse at any time: the project layer through a chore
  MR, the local layer at once.
- `/kaizen` gains a third state for cost data — disabled by choice — besides measured and not yet
  recorded. A window of disabled MRs is not evidence that cost fell.
- The price table is a maintenance item: it must be re-copied from its `source` within 90 days,
  and a new model needs a row before its first MR is priced. Neither failure is silent (the line
  is omitted with a reason), but nothing warns before it happens.
- Debt, stated rather than tracked: no CI job validates the cost lines in an MR description
  (one `cost-ledger: off`, no cost line beside it, no second `est-cost-usd:`); the transcript
  layout can change without notice; and #4859 renamed the local git-config key to
  `trueppm.costLedger` (the first port still read the template's key while its doc named this
  one), so an opt-out written under the template's key no longer applies.
