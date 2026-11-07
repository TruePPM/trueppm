# The cost ledger setting

The cost ledger is the set of cost lines `/mr` and `/wave` write in an MR's
`## Gates` section: the measured `subagent-tokens:` and `orchestrator-tokens:`, and the one
estimate, `est-cost-usd:`. They let a reader tell what a branch cost and, over many MRs, which
gates and rework rounds earn their cost. One setting, `cost-ledger`, turns all of them on or off
together. It is **on by default**. The decision is
[ADR-1340](../adr/1340-cost-ledger-setting.md).

The same setting governs the `## Cost of this MR` comments that `scripts/cost-table.py` renders
(see *The cost records* below), the only
human-readable cost table on an MR. There is no second toggle: with the ledger on, an MR carries
both the lines and the records; with it off, neither.

## Check it, and turn it on or off

```bash
scripts/cost-ledger status          # e.g. "cost-ledger: on (set by: project)"
scripts/cost-ledger off             # project layer: edits .claude/cost-ledger.json
scripts/cost-ledger on              #   commit the file on a chore/ branch and open an MR
scripts/cost-ledger off --local     # you only, at once: git config --local trueppm.costLedger false
scripts/cost-ledger on --local      # you only: unsets that key (warns if the project says off)
```

- **For the whole project**, run `scripts/cost-ledger off` (or `on`) on a `chore/` branch, commit
  `.claude/cost-ledger.json` and open a chore MR. It takes effect for every branch made after the
  MR merges.
- **For yourself only**, run `scripts/cost-ledger off --local`. It takes effect on your next `/mr`
  or `/wave` run, in every worktree of the clone, and is never committed. `on --local` only removes
  your opt-out; it cannot turn the ledger on over a project that chose off.
- `scripts/cost-ledger status` always says which layer decided. The details of each layer
  follow.

## Where it lives, and which layer wins

| Layer | Where | Who changes it |
|---|---|---|
| Project | `.claude/cost-ledger.json`, committed: `{"_doc": ..., "schema": 1, "cost-ledger": "on"}` | the project, through a chore MR |
| Local opt-out | `git config trueppm.costLedger false` (local, or `--global`) | one person, at once, untracked |

Effective value: off if `.claude/cost-ledger.json` says off; otherwise off if `git config
trueppm.costLedger` is false (local or global); otherwise on. A local setting can turn
recording off, never on over a project that chose off. An unreadable layer counts as off.

Local git config lives in the clone's git common dir, so one `off --local` covers every
`scripts/wt` worktree of that clone. A local `true` has no effect: it can never override a
project `off`, and on a project that is on it is already the default.

## The command

`scripts/cost-ledger` is the only code that reads either layer.

| Command | What it does |
|---|---|
| `scripts/cost-ledger status` | Prints the effective value and the layer that set it, e.g. `cost-ledger: off (set by: git config, local; project: on)`. `--json` prints `effective`, `layer`, `project`, `local`, `global` |
| `scripts/cost-ledger enabled` | Quiet. Exit 0 on, 1 off, 2 a layer is unreadable. This is what skills and scripts consult |
| `scripts/cost-ledger off` / `on` | Edits `.claude/cost-ledger.json` in place (only the value changes). Commit it through a chore MR |
| `scripts/cost-ledger off --local` / `on --local` | `off` writes `trueppm.costLedger false` to the local git config; `on` only unsets it, and warns when the project still says off |

**Switchable any time, both ways.** The project layer changes through a chore MR and takes
effect for every branch once it merges (a branch made before then still has the old file). The
local layer takes effect at once, for the next `/mr` or `/wave` run. Toggling the setting is
not a gate change: no pre-MR gate reads it.

## What off records

With the ledger off, `/mr` and `/wave` write one line under `change-class:`:

```text
cost-ledger: off
```

and no `subagent-tokens:`, `orchestrator-tokens:` or `est-cost-usd:` line, and
no cost record (`scripts/cost-table.py` exits 3 and posts nothing, and `scripts/post-mr-cost.py`, the
only code that measures, stops before it reads a transcript). The three measuring scripts
(`scripts/orchestrator-tokens.py`, `scripts/subagent-tokens.py`, `scripts/est-cost.py`) also ask the setting first: when it is off
or unreadable they exit 3, print nothing on stdout and open no transcript. When the setting
is unreadable, the MR also carries the `## Notes` line "cost ledger setting unreadable;
nothing recorded".

The marker never names the layer, so a public MR does not say whether the project or one
person turned recording off. It does show that recording was off for that MR.
It takes no other value: with the ledger on there is no `cost-ledger:` line at all.

What off does not change:

- `budget-exceeded:` is still written: it counts agents that reached their `/wave` budget,
  not cost.
- `/wave`'s 150k `subagent_tokens` threshold for handing a late fix round to a fresh agent is
  control flow, read from the agent's result and never recorded. It applies either way. It is a
  context-size read of one notification, not the ledger's `subagent-tokens:` figure.

## Who checks it

Nothing in CI reads an MR description for cost lines: the lines are advisory and no gate requires
them. The two readers of a description that do exist leave them alone: `lint:mr-followups`
(`scripts/check-mr-followups.sh`) only reacts to follow-up wording, and the `/kaizen` gate-yield
parser matches `gate:` lines only. `/kaizen` reads the cost lines separately, through
`scripts/lib/ledger_lines.py` (§ 1g, *Cost beside yield*). What is checked is the tooling. The
`lint:cost-ledger` CI job (and `make cost-ledger-check`, part of `make pre-push`) runs the
`--self-test` of `scripts/cost-ledger`, `scripts/subagent-tokens.py`,
`scripts/orchestrator-tokens.py`, `scripts/est-cost.py`, `scripts/cost-table.py`,
`scripts/post-mr-cost.py` and `scripts/lib/ledger_lines.py`. A description-level validator (one
`cost-ledger: off` line, no cost lines beside it, no second `est-cost-usd:`) is not present in
this repository; until one exists, the
lines are only as consistent as the skills that write them.

## Reading the figures

- `subagent-tokens:` and `orchestrator-tokens:` are measured counts, never estimates, summed per
  response from transcripts in one unit (input + cache-write + cache-read + output), so they are
  comparable. `subagent-tokens:` covers the agents the orchestrator named and their descendants
  (the implementer's own gate batch). `est-cost-usd:` is the one estimate, its own labelled line
  (below), covered by this same setting.
- **`orchestrator-tokens:` is session spend over the window, not attribution.** It includes work that is
  not this MR's. Do not add the two lines up as the MR's cost.
- **The `## Cost of this MR` records of one session do not overlap, so they add up
  (trueppm#4865).** Each record claims only what no earlier record of that session claimed (see
  *Non-overlap* below). The `## Gates` ledger lines are different: they are
  `post-mr-cost.py --measure` snapshots taken at the go-ahead, which claim nothing, so the lines of
  two MRs from one session can still cover the same stretch. Read the comments, not the lines, when
  adding up a session.
- A window of disabled MRs is not evidence that cost fell.

## The `subagent-tokens:` line and the layout dependency

- **What it is.** `subagent-tokens: <N>` is the sum, per response and once per message id, over the
  transcripts of every agent the orchestrator spawned or resumed for the branch plus all their
  descendants (`parentAgentId`). Reference only: `scripts/post-mr-cost.py` (`--measure`, the hook,
  `--round`) runs `scripts/subagent-tokens.py` with the right per-agent windows; nobody runs it by hand.
  The parser is `scripts/lib/transcript_usage.py`, shared with `scripts/orchestrator-tokens.py`.
- **Layout dependency.** The script reads `<projects-dir>/<slug>/<session-id>/subagents/agent-<id>.jsonl`
  and the sibling `agent-<id>.meta.json`. That layout is not documented upstream (observed
  2026-11-03) and Claude Code deletes transcripts after `cleanupPeriodDays` (30 days), so the line
  is written at MR time or not at all. It **fails closed**: an id with no transcript, or a session
  directory that does not resolve, exits 1 and prints no line, because a partial sum would read as
  a measured one. One gap remains: descendants are found only through `parentAgentId` in the
  meta files, so a nested agent whose transcript exists but whose meta file is missing is not
  found, and the sum is partial. Locally, 3 of this repository's 807 subagent transcripts (8 of 4,495
  across all projects) had no meta file, checked 2026-11-07.
- **Where the transcripts are.** `<projects-dir>` is `$CLAUDE_CONFIG_DIR/projects` when that is
  set, else `~/.claude/projects`; `--projects-dir` overrides it. The `<slug>` below it is derived
  by Claude Code from the directory the session was **started** in, so a session started in the
  main checkout and one started inside a `scripts/wt` worktree (`../trueppm-wt/<leaf>`) sit under
  different slugs, and a later `cd` does not move either. No script computes a slug: each globs
  `<projects-dir>/*/<session-id>` and needs exactly one hit, so the session id alone finds the
  transcript from any directory, and an id under two slugs fails closed (exit 1, no line). The
  session id is `$CLAUDE_CODE_SESSION_ID`, so the orchestrator runs these scripts in its own
  session, never inside a subagent's.
- **A window with no subagent.** `--no-agents` is the explicit statement that none ran: it prints
  `subagent-tokens: 0`, a measured zero, and opens no transcript. Without `--agent` and without
  `--no-agents` the script exits 2, so a forgotten `--agent` can never become a 0; the two
  together are a usage error.


## The `est-cost-usd:` line

`est-cost-usd: <N.NN> (prices YYYY-MM-DD)` lets "findings per dollar" be asked. It is **a list-price equivalent: what the same tokens would
cost at the public API rates, not the amount a subscription charged.** It is never folded into a
measured line, and never added to a measured figure.

- **What it prices.** The orchestrating session's own usage over `--since`/`--until` (the window
  `scripts/orchestrator-tokens.py` takes) plus the agents `scripts/subagent-tokens.py` takes
  (`--agent <id>` and their descendants, up to `--until`), each response priced with its own
  `message.model` and four usage classes, once per message id. The line is omitted when any piece
  is missing, because a partial price would read as a whole one.
  `scripts/est-cost.py` (reference only; `scripts/post-mr-cost.py --measure` runs it for you, with the
  right windows) prints the line on stdout; the per-model figures, or the reason for an omission as a `note:`
  line for the MR's `## Notes`, go to stderr. Exit 0 priced, 1 omitted, 2 usage, 3 ledger off
  (it asks `scripts/cost-ledger enabled` first and opens nothing).
  `--no-agents` in place of `--agent` prices the orchestrator alone, for a window in which no
  subagent ran; stderr labels the run `orchestrator-only`. It is never a default, as for
  `subagent-tokens.py`.
- **The price table.** `.claude/model-prices.json`: full model IDs as keys, USD per million
  tokens for `input`, `cache_write_5m`, `cache_write_1h`, `cache_read` and `output`, an optional
  `long_prompt` tier (Claude Haiku 5.5 prices a response whose prompt is over 100,000 tokens
  differently), a `checked` date and the `source` URL. Prices are copied from that page by a
  person and checked in review, never invented. Keys are matched exactly against each response's
  `message.model`: there is no prefix or family fallback, so a new model ID (or an older one still
  inside the 30-day transcript window) needs its own row. The table carries every current model
  plus previous-generation rows (`claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`,
  `claude-haiku-4-5`) kept so a session that still runs on one is priced rather than omitted
  (`claude-sonnet-5` was the one seen in local transcripts when they were added); a model with no row makes the whole
  line omitted with `note: est-cost-usd omitted: model <id> has no row in the price table`,
  never a $0 row. Responses with all-zero usage (`<synthetic>` entries) price at 0 without a row. A table older than 90 days, missing, malformed or
  without a row for a model used, or a response in fast mode (`speed` other than `standard`), with a
  non-global `inference_geo` or with a `service_tier` other than `standard` (the table has no multiplier for any), gives no line and a `## Notes` line saying why; a stale table
  does not warn anyone, so refresh it (re-copy, update `checked`) when MRs carry
  `subagent-tokens:` lines but no `est-cost-usd:` line.
- **Cache writes.** A response's cache write is split by
  `message.usage.cache_creation.ephemeral_1h_input_tokens` (1-hour rate) and the rest (5-minute
  rate). A response without a valid split is priced entirely at the 5-minute rate, the cheaper
  one, so the estimate can understate on that field and never overstates.
- **Layout dependency.** The same undocumented `subagents/agent-<id>.jsonl` layout as
  `subagent-tokens:` (observed 2026-11-03), failing closed in the same way.

## The cost records

GitLab renders the bare ledger lines at the end of `## Gates` run together with `change-class:`
as one paragraph, so a person reading a merged MR could see each gate's model but not the tokens
or the cost. The readable table is therefore an MR comment,
`## Cost of this MR (#<issue>)`, with a Sonnet vs Opus split. It is the only human-readable cost
table: the description carries no `## Cost` section, and the ledger reader looks only at `## Gates`.

Work on an MR after its first comment is a further comment, never an edit:

- **Record 1** covers the session's work up to the moment `glab mr create` ran (the hook measures
  it then; trueppm#4865), not the description's ledger lines, which are the go-ahead snapshot from
  `--measure`. Its heading has no record number, so a comment posted before records existed
  counts as record 1.
- **Record K** (2, 3, ...) covers one later window: a fix round after the MR opened, a `/fix-mr`
  pass, a re-measure. Its heading is `## Cost of this MR (#<issue>) — record K`, it states its
  window start and end, its figures come from the measuring scripts' own stdout lines for that
  window (not from the description), and it adds a running-total row across records 1..K.
- **The `## Gates` ledger lines are the go-ahead snapshot.** Nothing sums the later records except
  each record's own running-total row.
- **One record per window.** A re-run for the same window (same start and end) updates that
  window's record, which must be the latest; a different window posts a new one. An earlier
  record is never edited: record 1 is refused (exit 5) once a record 2 exists, and so is a window
  that matches any record but the latest.
- **A subagent that keeps working after a record is counted in the next one, once.** Each agent
  has its own watermark (the end of the last record that measured it), and the next record counts
  that agent only for usage after it (`--agent <id>@<since>`, below).
- **A window with no subagent** (a typical `/fix-mr` pass) shows a **measured 0** for the
  Subagents row (0 tokens, 0.00 USD; each family `none used`), and Total tokens and Est. cost are
  real, as are the running totals. The 0 comes only from the explicit statement `--no-agents`,
  given to both `scripts/subagent-tokens.py` (prints `subagent-tokens: 0`) and
  `scripts/est-cost.py` (prices the orchestrator alone). A forgotten `--agent` is not a 0: without
  `--agent` and without `--no-agents` both exit 2. A `subagent-tokens: 0` beside real subagent
  split lines is not trusted: the record says the split does not sum to the line. An orchestrator
  with no usage in the window still prints no line, so its cells stay `n/a`.

### Non-overlap: per-session state and attribution

trueppm#4865, ported from macrodream/blueprint#387. An audit of the last 40 MRs in three repos found
records that repeated the session's growing total (trueppm !3247, !3248 and !3249 all showed 515,339
Opus orchestrator tokens), a window marker shared by every session and worktree, and subagents
attached to whichever MR opened first. The decision: **records do not overlap.** Each record claims
only tokens no earlier record of the same session claimed, so summing every record a session posted
gives that session's total. In a parallel wave the first MR to open carries the orchestrator spend
interleaved up to that point, and the record's footnote says so.

- **State.** `${CLAUDE_CONFIG_DIR:-~/.claude}/mr-cost-state/<session-id>.json`, one file per session and
  not per repo (a session spans repos, so a record in one repo must advance the window every other repo's
  record starts from; the old per-repo files under `<git-common-dir>/mr-cost-state/` are never read):
  `{"schema": 1, "orchestrator_until": "<UTC Z>", "agents": {"<agent-id>": "<UTC Z>"}}`, written
  atomically (a temp file in the same directory, then `os.replace`) after **every** successful post
  by `scripts/post-mr-cost.py`: `orchestrator_until` and the watermark of each agent that record
  measured (descendants too) move to the record's `until`. It is per session. The legacy shared
  `mr-cost-last-until` marker is **never read**, not even as a fallback; delete it if you find one. A state file that exists but
  does not validate posts nothing and says so, because guessing a window would double count. A
  failed post never advances the state.
- **A record with no `pending` entry that landed without the state moving (reconcile).** Records this
  version posts are settled by the write-ahead `pending` claim (below), which covers a landed post on any
  MR. Reconcile covers only a record with no pending entry: one posted by an older version of this code,
  or after the state file was lost. The next run of the hook (on an MR that already has a cost comment) or
  of `--retry` adopts such a record: it posts nothing and advances the state to the record's end, for the
  orchestrator and for the agents that record's window would have attributed. A record is adopted only if
  it is **this session's**, which is decided by its window **start**: the token user's own record whose
  `Window: <since> to <until>` line starts exactly at the session's current `orchestrator_until` (a
  session with no state yet matches the session's first transcript entry), and whose end is not in the
  future. A record another session posted on the same MR starts at that session's own watermark, a record
  by another user is never read, and an older record with no `Window:` line has no start and is never
  adopted; in those cases the hook posts nothing and leaves the state alone, and `--retry` falls through
  to `--round`. It never moves a watermark backwards. Only expected failures (an unreadable state, a
  missing transcript) read as "nothing to adopt"; any other error is reported, not swallowed.
- **Windows.** Orchestrator: from `orchestrator_until` to now (no state: from the session
  transcript's first entry). Each agent: from its own watermark to now (none: from its first entry);
  a descendant is measured over its own watermark and goes with its top-level parent. A watermark is
  an exclusive bound, so a response stamped exactly at the previous record's end is counted once.
  The measuring scripts take this as `--agent <id>@<since>` (and `--agent-since <id>@<since>` for an
  agent that is not named, such as a descendant) on `subagent-tokens.py` and `est-cost.py`.
- **Attribution of top-level agents to an MR.** A subagent transcript's `cwd` and `gitBranch` always
  show the session root and `main`, so they cannot say which branch an agent worked on. Two things in
  the transcript can:
  1. **Where it acts** (strongest). The git worktree, and so the BRANCH, holding the majority of the agent's `Edit` / `Write` / `NotebookEdit` `file_path`s; else the one
     its Bash `cd <path>` and `git -C <path>` (not `show`, `diff` or `log`) calls target most, when one
     leads strictly (a read-only auditor `cd`s into what it audits). When that home is known the agent
     counts for this MR if it is this MR's worktree and not otherwise, and its brief is ignored: a
     port agent's brief names the worktree it reads as well as the one it writes, so the brief cannot
     tell them apart. A path is resolved with `git worktree list --porcelain` for the hook's repo (the
     deepest listed worktree containing it): the agent counts for this MR only if that worktree's branch
     is the MR's source branch. This is what keeps `/wave`'s workers, which run under
     `<main>/.claude/worktrees/agent-*` while the MR is opened from the main checkout, apart: a path
     there is a worker's branch, never the main checkout's, and one under `.claude/worktrees/` that git no
     longer lists is no home at all. Only a path in no listed worktree (another repo's, or one already
     removed) falls back to the `*-wt/<issue>-<slug>` leaf. Two worktrees written equally often are no
     home (a strict majority is required), so the `cd` rule decides, then the brief.
  2. **Its brief** (the text of its first `user` entry), when no home is known. It counts if it names
     this MR's source branch, branch leaf or worktree leaf (`<issue>-<slug>`); it is left for another
     record if it names another branch `(feat|fix|docs|chore)/<digits>-...` or another worktree path
     component `.../<issue>-<slug>`; a brief naming both this MR and another keeps this MR; an unnamed
     gate counts if it has usage after its watermark, so the first record to open claims it.

  `--agent` and pins override both. Briefs, paths and commands are untrusted text: they are classified
  and matched, never printed.
- **Empty rows.** Claude Code writes `<synthetic>` assistant entries with all-zero usage on an
  interrupt or an error. The parser drops any response whose four usage values are all zero and
  counts it in the `empty` figure on stderr, so no `model unknown 0` split line exists and the
  **Other** column appears only when a model outside Sonnet and Opus used tokens.
- **The golden fixture.** `scripts/tests/cost-ledger-golden/` is one synthetic session (an
  orchestrator, an agent with a nested descendant, an agent for another branch that started before
  the first MR opened, an unnamed gate, a zero-usage row, an agent resumed after its record) replayed
  through the real hook, `--round`, the state files and `cost-table.py` with a fake `glab` and a temp
  git dir. `expected.json` pins each record's totals and rows and that the three records add up to
  the session's usage with nothing claimed twice. `python3 scripts/post-mr-cost.py --self-test`
  runs it. The directory is byte for byte the same in every repo that carries this harness
  (Blueprint holds the canonical copy), so it names no repo-specific path or issue.

### Concurrency and known limits

- **One post at a time per session.** The state (and the pins) are a read, a post and a write. An
  exclusive `flock` on `mr-cost-state/<session-id>.lock` is held from reading the watermark through
  writing it, by the hook, `--round`, `--retry`, reconcile and `--pin`, so two MRs opened at once in one
  session claim consecutive windows instead of the same one, and neither drops the other's agent
  watermarks. (No locking on a platform without `fcntl`; the writes stay atomic.)
- **A post that lands while its state write does not (the write-ahead `pending` claim).** Before a post,
  inside the lock, the state file gets `"pending": {"mr", "project", "since", "until", "agents"}` beside the
  unchanged watermarks; after a confirmed post the watermarks move to those values and `pending` is removed.
  If the POST landed but the commit did not (cost-table exited non-zero after it, a kill, a timeout), the
  next run of the hook, `--round`, `--retry`, `--measure` or `--pin`, on ANY MR, settles it first by reading
  the pending MR's notes: a record by the token user with exactly that `Window: S to U` was posted, so the
  claim is committed; none, with the notes read, was not posted, so the claim is dropped and the window is
  claimed again exactly once; notes that cannot be read refuse the post (and print the `--retry` command),
  never a guess (a malformed state or pending entry is reported with the state file's path and the reason,
  and the fix is to inspect or remove that file, not to retry). `--measure` commits or drops a pending entry
  but never posts, and `--pin` is written even when the entry cannot be settled. Reconcile stays for
  a record with no `pending` entry, one posted by an older version of this code or after the state file was
  lost, where only the window-start rule can tie it to this session.
- **Known limit: agents that write in a detached-HEAD worktree, or in the main checkout while it is on
  the default branch, belong to no MR.** Their home is a worktree with no branch, or a branch no MR has as
  its source, so they are excluded from every record. Run such work in a branch's own worktree.
- **Known limit: a record edited after it was posted can be claimed twice.** A pending claim is settled
  by matching the record's `Window: S to U` line. If someone edits the comment so it no longer parses, or
  changes its window, the claim is read as absent, dropped, and the window is claimed again.
- **Known limit: a `glab` child that outlives `cost-table.py`'s 300 s timeout.** If it lands its POST after
  the pending claim was settled as absent (dropped), that window is claimed again and the record exists
  twice.
- **Known limit: an agent attributed to a branch that never gets an MR in this session is never claimed.**
  Attribution sends an agent's tokens to the MR of the branch it works on. If that branch is abandoned,
  or its MR is opened from another session, no record of this session ever includes the agent. Nothing
  double counts, but those tokens are in no record. `--agent <id>` on a `--round` for another MR counts
  them there by hand.
- **Known limit: a session's first record includes the work done before its MR's issue.** Its
  orchestrator row starts at the session's first entry, and says so.

### One repo per hook, and explicit projects

The hook runs in the **session's** directory, which can be a different repo from the one an MR was
opened on (a worktree of another project, or `glab mr create -R`). Reading the MR by iid in the wrong
repo would post a cost record on an unrelated MR. So the hook parses the project path from the printed
MR URL (`https://<host>/<namespace/project>/-/merge_requests/<n>`) and posts only when it equals the
project of the repo it runs in (its `origin` remote); otherwise it posts nothing and prints
`python3 scripts/post-mr-cost.py --retry --mr <n> --session <sid>` to run in the right checkout. Every
`glab api` call also names its project explicitly (`projects/<url-encoded path>/...`, and
`cost-table.py --project`), so nothing resolves `:id` against whichever repo the process happens to
run in. The golden fixture's fake `glab` rejects `:id` and any other project, and one step replays a
`glab mr create` printed for another project.

### The records post themselves

Provenance: ported from Visiban's `post-mr-cost.py` (visiban/visiban#2128 and follow-ups) and
Blueprint's cost-comment work (macrodream/blueprint#384, macrodream/blueprint#387).
`scripts/post-mr-cost.py` is the only code that measures and posts a record; a person or a skill
never runs the three measuring scripts by hand, and nothing writes a window marker.

- **Record 1: the hook.** After any `glab mr create` run through Claude Code's Bash tool, the
  PostToolUse hook `.claude/hooks/post-mr-cost.sh` (registered in `.claude/settings.json`, timeout
  600) runs `scripts/post-mr-cost.py`. It posts nothing when `scripts/cost-ledger enabled` is not 0,
  when the MR description carries `cost-ledger: off`, or when this user already has a `## Cost of
  this MR` comment on the MR (so a record is never posted twice). Otherwise it measures the
  session's next window (above), posts record 1 through `scripts/cost-table.py`, and advances the
  state. The description's ledger lines are the go-ahead snapshot and are **not** what record 1
  renders from: rendering them would repeat a figure an earlier record already claimed. The session's
  transcript is found by session id under `$CLAUDE_CONFIG_DIR/projects/*/` (else `~/.claude/projects/*/`), so a session run from the main
  checkout is found whether its agents worked in the checkout or in a `../trueppm-wt/<leaf>/`
  worktree.
- **The go-ahead snapshot: `--measure`.** `python3 scripts/post-mr-cost.py --measure` prints the
  `subagent-tokens:`, `orchestrator-tokens:` and `est-cost-usd:` lines for the window the next
  record would cover, for the MR description's `## Gates` section. It never posts and never moves a
  watermark, so the hook still claims the same tokens at `glab mr create`; its only state writes are the
  pins (`--pin`) and settling a pending claim from an earlier post (committing it if the record landed,
  dropping it if not). It attributes by the
  current branch and worktree.
- **Record K: `--round`.** `python3 scripts/post-mr-cost.py --round --mr <iid>` after the push of
  a fix round (`/fix-mr` does this). It posts `## Cost of this MR (#N) — record K` with the window
  that session has not yet claimed, whatever other sessions posted on the MR (the MR must already
  carry a readable record, the `cost-table.py --next-since` value), a running total across records, and
  advances the state.
  A re-run posts a record only if the orchestrator or an attributed agent has new usage since the
  last post; otherwise it says there is nothing measurable.
- **`--agent <id>`** (repeatable, `--round` and `--measure`): name exact agents (the `agentId:` of
  the Agent tool result) instead of auto-attribution; a named agent is always counted if it has
  usage in the window.
- **`--measure --agent <id>` without `--pin`** applies to that run only and prints a one-line stderr
  warning: record 1 (the hook) will not attribute those agents unless they are pinned.
- **`--measure --agent <id> --pin`:** run it in the branch's own worktree. It also records those
  agents as belonging to this branch, in `${CLAUDE_CONFIG_DIR:-~/.claude}/mr-cost-state/<session-id>.pins.json`
  (`{"schema": 1, "branches": {"<project>:<branch>": ["<agent-id>"]}}`, the project being the `origin`
  project so one branch name in two repos cannot collide; written atomically, kept apart from the
  state file). The hook (record 1) and `--round` (record K) read it, so an agent whose brief
  names no branch is attributed to the same MR in the snapshot and in the records, and is left out
  of every other branch's record. It refuses (exit 2) to pin to the default branch (`main`, or
  whatever `origin/HEAD` names): no MR has that source branch, so the agent would be left out of
  every real branch's record and its tokens never claimed.
- **`--retry --mr <iid> --session <sid>`:** what a fail-soft message tells you to run (it prints the
  session id, or `<session-id>` when none was usable, and the literal `<iid>` when no MR number was
  known), in the checkout of the MR's project. It posts record 1 when the MR has no cost comment
  yet (the hook's work), otherwise the next record (`--round`'s), and advances the state like any
  other post. Before posting a later record it runs the same `reconcile()` as the hook: when a record this
  session posted landed without the state moving, it posts nothing, moves the state (and the agents
  that record measured) to its end and says so, instead of re-counting them in a round.
- **Failures are retried, explained and visible.** `cost-table.py --post` retries the whole
  read-then-write up to 3 times (2s then 5s backoff, 20s per `glab api` call, at most 3 notes pages per attempt: 307s worst case; the hook's own timeout on it is derived from `worst_case_seconds()` in `cost-table.py` plus 30s, 337s, so the whole hook fits its 600s limit. An MR with 300 or more notes exits 5, which is not retried) when a call fails or
  hangs. It retries from the top, not the single call, because a POST that timed out may have
  landed: the retry re-reads the notes and updates that record 1 in place, so a retry never mints a
  second record 1. When it still fails, cost-table's stderr reason (which call, timeout or exit) is
  appended to the message and written to `mr-cost-hook.log`. A failure or skip is also emitted as a
  hook `systemMessage`, so the user sees it in the terminal and not only the model. The hook's own
  reads (MR description, notes, `--next-since`) are retried the same way, the notes are paged past
  100 (at most 2 pages, 200 notes, to fit the hook's time budget: more reads as unreadable, never as
  absent), and `--round` tells "no record 1" (exit 1) from "API failure" (exit 4).
- **Cheap pre-filter.** The hook fires on every Bash call, so `post-mr-cost.sh` buffers the payload
  and starts python only when it matches `*glab*mr*create*`; python then re-filters with its own
  stricter `glab mr create` pattern, so a loose shell match is harmless.
- **What stays silent, and what does not.** A plain `off` (the setting, or `cost-ledger: off` in the
  description) is a choice and is only logged. An **unreadable** setting, or an MR description
  that could not be fetched (so the opt-out marker cannot be checked), posts nothing and is
  reported to the session and logged.
- **Fail-soft.** The hook always exits 0. A broken transcript layout, an unreadable notes API or
  a failed post is reported to the session with the command to re-run, never silently, and never
  blocks `glab mr create`. An unreadable notes read is reported, not treated as "a comment exists".
- **It logs every `glab mr create` it sees**, one line each, to `mr-cost-hook.log` in the clone's
  git common dir: time, session id, MR number and a fixed outcome. No command text or token is
  logged, and the log rotates at 256 KB. **No line for an MR opened through Claude Code means the
  hook never ran in that session**, usually because the session started before the hook was in the
  checkout (hooks load at session start) or the MR was opened another way.
- **`cost-table.py` is reference only.** It renders and reads records
  (`--comment`, `--next-since`) and is called by `post-mr-cost.py`; do not run it by hand to post a
  record, since a record posted that way does not advance the session state and the next record
  would count the same tokens again. `--self-test` covers each mode with a fake `glab api`.
- **Limit.** An MR opened in the GitLab UI or a plain terminal gets no comment.

Exit codes of `cost-table.py`: 0 rendered (printed or posted); 1 no `## Gates` section (for record
K, never: the lines file is read as one); 2 usage or an unreadable file; 3 the ledger is off or
unreadable, or the lines carry `cost-ledger: off`, so no record and no API call; 4 the notes or the
token's user could not be read or written; 5 refused, the window belongs to an earlier record.

### What a record shows

- **Sonnet vs Opus.** A tokens and an estimated-cost column per model family, for subagents and
  for the orchestrator, plus the ledger lines' totals. The family is read from the model ID
  (`sonnet` or `opus` in it); any other model (Fable, Haiku) adds an `Other` pair of columns to
  that record rather than being dropped or folded into Opus. The per-model figures come from the `model`
  lines the measuring scripts print on stderr (`subagent-tokens: model <id> <N>`,
  `orchestrator-tokens: model <id> <N>`, `est-cost: subagent|orchestrator model <id> <USD> USD`);
  `--split <file>` is those stderr streams concatenated, and no other line in it is read.
- **n/a, never 0.** A model with no estimate (no price row, or `est-cost.py` omitted its line), a
  missing, doubled or malformed ledger line, or no window end shows `n/a` with a fixed reason; it
  never echoes the line's text (MR text is untrusted). A family a side did not use shows
  `none used`. **No per-model split at all** (no split file, or neither side has a family) renders a
  compact two-column `Tokens | Est. cost` table, not a per-family table of `n/a` cells: the
  Subagents and Orchestrator rows show their tokens and a `-` for cost (a measured 0 shows
  `0.00 USD`), and the Total row is the record. A compact record parses and numbers like any other.
  If a side's split does not sum to its ledger line, the record
  says so; the line is the record. The Total tokens cell is `n/a` unless both token lines are
  present.
- **States.** The window, always its actual start and end (record 1 posted by the hook or `--retry` states
  `Window: S to U.`; the older `Window end: X.` form, which assumed the go-ahead, still parses), plus, on a
  session's first record only, that the orchestrator row starts at the session's start and includes work
  done before this MR's issue, that
  the cost is a list-price estimate from `.claude/model-prices.json` with its price date, the
  `budget-exceeded:` count (record K: `n/a`, not measured for a later window), and the
  non-overlap sentence: "Records do not overlap: the orchestrator row is this session's spend since
  its previous cost record, across every branch it worked, and each subagent is counted only for
  usage after its previous record. Records from one session add up to its total." (Comments posted
  before trueppm#4865 carry the older never-add sentence and still parse.) A record K states each
  stretch this MR has no record for: before its own window, or between two earlier records. The
  work in such a stretch is in another MR's record from the same session, or in none.
- **Other.** The `Other` column appears only when a model outside Sonnet and Opus used tokens.
- **Off.** It follows the cost-ledger setting with no toggle of its own: ledger off or
  unreadable, or a `cost-ledger: off` marker, means exit 3 and no record; existing records are
  left alone.

### Reading earlier records back

Earlier records are MR notes, which anyone who can comment can write, so the running total is
built only from notes that pass every check:

- authored by the token's own user (`glab api user`); a note with the heading by anyone else is
  counted ("N note(s) with this heading by another user were not read") and never read, numbered
  from or edited;
- the generated heading as the first line and the generated footer as the last;
- at most 32 KB, ASCII apart from the heading's dash, exactly one header row, one **Total** row and
  one window line, every Total cell a bold figure of a fixed shape (`1,234`, `0.40 USD`) or
  `n/a (...)`, and valid UTC times.

A failed check never becomes 0 or a guess: the running-total row reads `n/a` and the record states
why, from a fixed list (an earlier record did not parse; this user's earlier records are not exactly
records 1 to K-1, which covers a missing number and a duplicate; an earlier record states no window
end). Windows that overlap in time are not on the list: records are non-overlapping in tokens, not in
time (each claims what no earlier record of its own session claimed), so two sessions' records on one MR
may cover the same hours and the running total simply sums them. A time gap between two windows is not
on the list either: the total still adds up and the record
states each stretch this MR has no record for ("This MR has no record for X to Y"), whether it is
before this window or between two earlier records. The record's number is
still one past every record number this user's notes carry, so a malformed note is never
overwritten. A column one record has `n/a` in is `n/a` in the running total; the others still add
up. No note text is echoed in any message or record.

The script never overwrites a note it cannot identify: record 1 is updated only when this user has
exactly one, and it parses (otherwise exit 5), and two notes with the latest record number are both
left alone (their window is refused with exit 5; a new window posts a new record with the total `n/a`). It reads at most 2,000 notes and exits 4 on
an MR with more, so a flood of comments stops the records rather than skewing them. Two sessions
posting to one MR at once can both post the same number; the next record then reads `n/a`, so run
one cost post per MR at a time.

### An example

A record 2, as `--comment --ledger ... --split ... --since 2026-11-04T15:38:24Z` renders it
for a window that used 1,500 Sonnet tokens (the self-test's case; the per-side rows are elided):

```markdown
## Cost of this MR (#4859) — record 2

| | Sonnet tokens | Sonnet est. cost | Opus tokens | Opus est. cost | Total tokens | Est. cost |
|---|---|---|---|---|---|---|
| ... | ... |
| **Total** | **1,500** | **0.40 USD** | **0** | **0.00 USD** | **1,500** | **0.40 USD** |
| **Running total, records 1-2** | **11,560,862** | **3.50 USD** | **0** | **0.00 USD** | **11,560,862** | **3.50 USD** |

- Window: 2026-11-04T15:38:24Z to 2026-11-04T17:00:00Z. This record counts only the work in this window; the running-total row adds the earlier records.
- Running total: the last row, records 1-2.
```

The amount is written `1.57 USD`, not with a dollar sign, so GitLab never reads a pair of `$` as
inline math.
