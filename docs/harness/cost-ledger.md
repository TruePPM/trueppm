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
no cost record (`scripts/cost-table.py` exits 3 and posts nothing). They do not run
`scripts/orchestrator-tokens.py`, `scripts/subagent-tokens.py` or `scripts/est-cost.py`, and all three also ask the setting first: when it is off
or unreadable they exit 3, prints nothing on stdout and opens no transcript. When the setting
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
- **Do not sum `orchestrator-tokens:` across the MRs of one wave.** The branches' windows
  overlap in one orchestrating session, so each figure is the session's spend while that
  branch was open, not an attribution to it.
- A window of disabled MRs is not evidence that cost fell.

## The `subagent-tokens:` line and the layout dependency

- **What it is.** `subagent-tokens: <N>` is the sum, per response and once per message id, over the
  transcripts of every agent the orchestrator spawned or resumed for the branch plus all their
  descendants (`parentAgentId`), from `scripts/subagent-tokens.py --agent <id> ... --until <T>`.
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
  `python3 scripts/est-cost.py --agent <id> [--agent <id> ...] --since <T> --until <T>`
  prints the line on stdout; the per-model figures, or the reason for an omission as a `note:`
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

- **Record 1** covers the branch up to the go-ahead to push. Its figures are the description's
  ledger lines, and its heading has no record number, so a comment posted before records existed
  counts as record 1.
- **Record K** (2, 3, ...) covers one later window: a fix round after the MR opened, a `/fix-mr`
  pass, a re-measure. Its heading is `## Cost of this MR (#<issue>) — record K`, it states its
  window start and end, its figures come from the measuring scripts' own stdout lines for that
  window (not from the description), and it adds a running-total row across records 1..K.
- **The `## Gates` ledger lines stay record 1's figures.** Nothing sums the later records except
  each record's own running-total row.
- **One record per window.** A re-run for the same window (same start and end) updates that
  window's record, which must be the latest; a different window posts a new one. An earlier
  record is never edited: record 1 is refused (exit 5) once a record 2 exists, and so is a window
  that matches any record but the latest.
- **A subagent still running after a record's window end is counted in no record.** The
  subagent scripts have no per-window cut (they count an agent's usage up to `--until`), so such
  an agent's later usage has no record to land in.
- **A window with no subagent** (a typical `/fix-mr` pass) shows a **measured 0** for the
  Subagents row (0 tokens, 0.00 USD; each family `none used`), and Total tokens and Est. cost are
  real, as are the running totals. The 0 comes only from the explicit statement `--no-agents`,
  given to both `scripts/subagent-tokens.py` (prints `subagent-tokens: 0`) and
  `scripts/est-cost.py` (prices the orchestrator alone). A forgotten `--agent` is not a 0: without
  `--agent` and without `--no-agents` both exit 2. A `subagent-tokens: 0` beside real subagent
  split lines is not trusted: the record says the split does not sum to the line. An orchestrator
  with no usage in the window still prints no line, so its cells stay `n/a`.

### The records post themselves

Provenance: ported from Visiban's `post-mr-cost.py` (visiban/visiban#2128 and follow-ups) and
Blueprint's cost-comment work (macrodream/blueprint#384).

- **Record 1.** After any `glab mr create` run through Claude Code's Bash tool, the PostToolUse
  hook `.claude/hooks/post-mr-cost.sh` (registered in `.claude/settings.json`) runs
  `scripts/post-mr-cost.py`, which posts record 1. It does nothing when `scripts/cost-ledger
  enabled` is not 0, when the MR description carries `cost-ledger: off`, or when this user already
  has a `## Cost of this MR` comment on the MR (so a record is never posted twice).
  **Which source wins: the description's ledger lines.** When a `subagent-tokens:`,
  `orchestrator-tokens:` or `est-cost-usd:` line appears anywhere in the description (a `/wave`
  MR; under `## Gates`, `## Notes`, in a fence or in a quote alike), the hook renders record 1 from
  the description through `cost-table.py --file` and does not measure, so the comment matches the
  description by construction (a line cost-table cannot read renders as n/a). A re-measured
  window cannot be right for a wave: its agents start before the previous MR's post, so the window
  excludes this MR's agents and can include another's (!3249 read 0.8M tokens against a ledger of
  10.8M). The per-model split comes from `wave-cost-split.txt` in the git dir of the checkout the
  MR was created from, and is used only when it is older than the MR, at most two hours older, and
  its token sums equal the description's lines. Then its mtime is the window end; otherwise the
  per-model cells read n/a, the totals are unchanged, and the window end is the MR's creation time
  (the hook's time if that cannot be read; the footer's "go-ahead to push" is then seconds off),
  so record 1 always has a readable window end for `--next-since` and `--round`. This path does
  not write `mr-cost-last-until` (it measures nothing, and the file is shared by every worktree).
  A description with no ledger key anywhere (a plain `/mr`) is measured: the window runs from the
  last MR this session posted for (`mr-cost-last-until.<session id>` in the git common dir; the
  window is per session because the common dir is shared by every worktree and parallel session,
  and a legacy unkeyed `mr-cost-last-until` is read only when no keyed file exists)
  or the session start, to now; subagents are the top-level ones that started in that window. The
  session's transcript is found by session id under `~/.claude/projects/*/`, so a session run from
  the main checkout is found whether its agents worked in the checkout or in a
  `../trueppm-wt/<leaf>/` worktree. `/wave` names its agents explicitly and is the more exact
  path (below), but the hook posts first, because it fires at `glab mr create`.
- **Record K.** The hook cannot see later work. After a `/fix-mr` pass, a review-fix or
  completeness-check fix push after the MR opened, or a rebase with conflict resolution before
  merge, run `python3 scripts/post-mr-cost.py --round --mr <N>`. It posts `## Cost of this MR (#N)
  — record K` for the window since the latest record, with the running total, and advances
  `mr-cost-last-until.<session id>` so the next MR does not re-count the round. It posts nothing, and prints one
  line saying why, when the ledger is off, the MR carries `cost-ledger: off`, record 1 is missing,
  or nothing was measured.
  Wave fix rounds are window-based until #4864: the window since the latest record can mis-count
  a wave's parallel agents, so prefer the by-hand path with named agents for a wave round.
- **Failures are retried, explained and visible.** `cost-table.py --post` retries the whole
  read-then-write up to 3 times (2s then 5s backoff, 20s per `glab api` call, at most 3 notes pages per attempt: 307s worst case; the hook's own timeout on it is derived from `worst_case_seconds()` in `cost-table.py` plus 30s, 337s, so the whole hook fits its 600s limit. An MR with 300 or more notes exits 5, which is not retried) when a call fails or
  hangs. It retries from the top, not the single call, because a POST that timed out may have
  landed: the retry re-reads the notes and updates that record 1 in place, so a retry never mints a
  second record 1. When it still fails, cost-table's stderr reason (which call, timeout or exit) is
  appended to the message and written to `mr-cost-hook.log`. A failure or skip is also emitted as a
  hook `systemMessage`, so the user sees it in the terminal and not only the model. The hook's own
  reads (MR description, notes, `--next-since`) are retried the same way, the notes are paged past
  100, and `--round` tells "no record 1" (exit 1) from "API failure" (exit 4). When a cost comment
  already exists, the session window moves to the end of the token user's own record, never
  backwards and never past now; a foreign or future-dated record is ignored.
- **Manual fallback.** The failure message prints a command that works as written:
  `python3 scripts/post-mr-cost.py --retry --mr <iid> --session <sid>` (a failed `--round` prints the
  `--round` equivalent); run it from the checkout root. It re-runs the hook's own
  logic for an MR that already exists (same window, same opt-outs), and posts nothing if a cost
  comment is already there.
- **Cheap pre-filter.** The hook fires on every Bash call, so `post-mr-cost.sh` buffers the payload
  and starts python only when it matches `*glab*mr*create*`; python then re-filters with its own
  stricter `glab mr create` pattern, so a loose shell match is harmless.
- **What stays silent, and what does not.** A plain `off` (the setting, or `cost-ledger: off` in the
  description) is a choice and is only logged. An **unreadable** setting, or an MR description
  that could not be fetched (so the opt-out marker cannot be checked), posts nothing and is
  reported to the session and logged.
- **Fail-soft.** The hook always exits 0. A broken transcript layout, an unreadable notes API or
  a failed post is reported to the session with the by-hand command, never silently, and never
  blocks `glab mr create`. An unreadable notes read is reported, not treated as "a comment exists".
- **It logs every `glab mr create` it sees**, one line each, to `mr-cost-hook.log` in the clone's
  git common dir: time, session id, MR number and a fixed outcome. No command text or token is
  logged, and the log rotates at 256 KB. **No line for an MR opened through Claude Code means the
  hook never ran in that session**, usually because the session started before the hook was in the
  checkout (hooks load at session start) or the MR was opened another way.
- **Limit.** An MR opened in the GitLab UI or a plain terminal gets no comment.

### Running it

All three modes are `scripts/cost-table.py`; `--self-test` covers each, with a fake `glab api`.

- **Record 1:** `python3 scripts/cost-table.py --comment --file <description.md> --issue <N>
  --until <T> --split <file> --post --mr <iid>`. Without `--post` it prints the body.
- **The next window's start:** `python3 scripts/cost-table.py --next-since --mr <iid>` prints the
  latest record's window end, the `--since` for the measuring scripts and for the record (exit 1
  when this user has no readable record with a window end).
- **Record K:** measure the window with `scripts/subagent-tokens.py`, `scripts/orchestrator-tokens.py`
  and `scripts/est-cost.py` (`--since` the value above, `--until` now; `subagent-tokens.py` takes
  no `--since`), keeping their stdout lines in one file and their stderr in another. Name only
  agents spawned fresh in the window, since a subagent's usage counts up to `--until` from its
  start: a resumed agent makes the subagent cells `n/a` with a stated reason (post the record
  without a `subagent-tokens:` / `est-cost-usd:` line). With no subagent in the window, pass
  `--no-agents` to `subagent-tokens.py` and `est-cost.py` instead of `--agent`. Naming only fresh
  agents is prose-enforced: no script checks it. Capture the end once
  (`T=$(date -u +%Y-%m-%dT%H:%M:%SZ)`), take the start `S` from `--next-since`, and save the pair
  with its MR number: `WIN="$(git rev-parse --git-dir)/wave-cost-window.txt"; printf '%s %s %s\n' <iid> <S> <T> > "$WIN"`.
  A re-run of the same record reads it back and reuses the pair only when the first field is this
  MR's iid (`WIN="$(git rev-parse --git-dir)/wave-cost-window.txt"; read -r I S T < "$WIN"`, then
  compare `$I` with the iid), because `--next-since` returns the posted record's own end; a pair
  saved for another MR or an earlier round is never reused. Then run `python3 scripts/cost-table.py --comment --ledger
  <stdout lines> --split <stderr> --since <S> --until <T> --issue <N> --mr <iid> --post`. Without
  `--post` it reads the earlier records and prints the body.

Exit codes: 0 rendered (printed or posted); 1 no `## Gates` section (for record K, never: the
lines file is read as one); 2 usage or an unreadable file; 3 the ledger is off or unreadable, or
the lines carry `cost-ledger: off`, so no record and no API call; 4 the notes or the token's user
could not be read or written; 5 refused, the window belongs to an earlier record.

### What a record shows

- **Sonnet vs Opus.** A tokens and an estimated-cost column per model family, for subagents and
  for the orchestrator, plus the ledger lines' totals. The family is read from the model ID
  (`sonnet` or `opus` in it); any other model (Fable, Haiku) adds an `Other` pair of columns to
  that record rather than being dropped or folded into Opus. The per-model figures come from the `model`
  lines the measuring scripts print on stderr (`subagent-tokens: model <id> <N>`,
  `orchestrator-tokens: model <id> <N>`, `est-cost: subagent|orchestrator model <id> <USD> USD`);
  `--split <file>` is those stderr streams concatenated, and no other line in it is read.
- **n/a, never 0.** No split file, a model with no estimate (no price row, or `est-cost.py`
  omitted its line), a missing, doubled or malformed ledger line, or no window end shows `n/a`
  with a fixed reason; it never echoes the line's text (MR text is untrusted). A family a
  side did not use shows `none used`. If a side's split does not sum to its ledger line, the record
  says so; the line is the record. The Total tokens cell is `n/a` unless both token lines are
  present.
- **States.** The window (record 1: its end, the go-ahead to push; record K: start and end), that
  the cost is a list-price estimate from `.claude/model-prices.json` with its price date, the
  `budget-exceeded:` count (record K: `n/a`, not measured for a later window), and that the
  orchestrator figure is the session's spend and is shared by every branch of the same wave, so
  two MRs' totals must not be added. A record K states each stretch no record covers: before its
  own window, or between two earlier records.
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
end; a window, or an earlier pair, starts before the previous one ended, which would count work
twice). A time gap between two windows is not on the list: the total still adds up and the record
states each uncovered stretch ("No record covers X to Y"), whether it is before this window or
between two earlier records. The record's number is
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
