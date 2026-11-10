# Tracker-reading gates: which rules block where

Five CI gates compare the tree against live GitLab issue state. Until #4925 they
ran the same whole-tree check on every MR pipeline and every main push, so any
edit to the **tracker** turned main red, and then every open MR's pipeline,
with no code change behind it. Filing an issue did it, closing one from the UI
did it, and so did closing one through a merge. Over 2026-10-27..11-10, 21 of
94 main push pipelines failed, and tracker-reading lint jobs were 19 of the 26
failed jobs.

Each rule is now split by **cause**:

- **MR-caused** drift is something the change itself does. It blocks the MR
  pipeline, the main push, and `make pre-push` (`tracker-refs-check`). The gate
  runs with `TRACKER_GATE_MODE=diff`, which is the default.
- **Tracker-caused** drift is something an edit to the tracker does. It blocks
  nothing. `tracker:drift-report` runs nightly with `TRACKER_GATE_MODE=drift`,
  which is the old whole-tree check, and keeps **one** tracking issue in sync.

The shared logic lives in `scripts/lib/gitlab-issues.sh`:

- `tracker_gate_mode` selects the mode.
- `tracker_gate_base` resolves the commit the change is measured against.
- `tracker_gate_closing_ids` returns the set of issues the change will close.
- `tracker_gate_file_at_base` reads a file as it was at that base.

## "The change will close"

| Context | Source of the closing set |
|---|---|
| MR pipeline | `GET /projects/:id/merge_requests/:iid/closes_issues`. This is GitLab's own set: description and commit-message keywords, and negated keywords too, such as the one in !3327's description (see #4883). A regex over the description is not enough. |
| `make pre-push` / main push | Closing keywords in the commit messages of `base..HEAD`. The parser is deliberately not negation-aware, because GitLab is not either. |

An unreadable `closes_issues` fails closed.

## The diff base

The base is resolved in this order:

1. `CI_MERGE_REQUEST_DIFF_BASE_SHA` on an MR pipeline.
2. `CI_COMMIT_BEFORE_SHA` on a main push.
3. `git merge-base origin/main HEAD` locally.
4. `HEAD` itself on a non-MR pipeline with no before-sha, such as a schedule or
   a manual run. Such a pipeline has no change to attribute.

A base missing from a shallow clone is fetched by sha. A base that still cannot
be resolved fails closed.

## Per-gate classification

| Gate (job) | Rule | MR-caused: blocks MR, main push, pre-push | Tracker-caused: nightly report only |
|---|---|---|---|
| `check-scheduler-readme-limitations.sh` (`lint:scheduler-readme-limitations`) | (a) "not committed" vs `release::committed` | The diff **adds** a committed issue to the paragraph | An issue already in the paragraph was relabeled |
| | (b) every open scheduler+correctness defect is listed | The diff **removes** an entry for a still-open defect it does not close | A newly filed defect is not listed yet |
| | (c) no closed issue is listed | The change **closes** a listed issue and keeps the entry, or the diff **adds** an entry for an already-closed issue | A listed issue was closed outside an MR |
| | section and paragraph exist | Tree-only, so it blocks in both modes | — |
| `check-todo-grep.sh` (`lint:todo-grep`) | STUB:/WIP:, bare TODO warning | Tree-only, unchanged | — |
| | `TODO(#N)` names an open issue | A `TODO(#N)` on a line the diff **adds** whose issue is closed or missing, or any `TODO(#N)` whose N the change closes | A pre-existing TODO whose issue closed elsewhere |
| `check-known-issues-freshness.sh` (`docs:known-issues-freshness`) | closed reference without the ack marker | A reference on a line the diff adds or edits, or an unmarked reference to an issue the change closes | An untouched line whose issue closed |
| | release claim matches the milestone | A claim on a line the diff adds or edits | An untouched claim whose issue was re-milestoned |
| | heading matches its section | Tree-only, so it blocks in both modes | — |
| `check-suppression-issues.sh` (`suppressions:check`) | `SUPPRESSED-UNTIL(#N)` names an open issue | A marker on a line the diff adds whose issue is closed or missing, or any marker whose issue the change closes | A pre-existing marker whose issue closed (the #2603 case) |
| `check-claude-md-stale-issues.sh` (`lint:claude-md-stale-issues`) | closed issue described as live | A trigger sentence on a line the diff adds or edits, or one citing an issue the change closes | An untouched sentence whose issue closed |
| `check-issue-boundary.sh` (`boundary:check`) | no open issue labeled `enterprise`/`portfolio` | n/a: label-driven by design | **Kept as its own blocking job on main and schedule**, and also listed in the nightly report |

`boundary:check` was weighed and kept blocking. An enterprise label on an open
OSS issue is a governance leak worth an immediate red, the fix is a relabel
that takes seconds, and the job never runs on MR pipelines, so it cannot fail
an unrelated MR. The report lists it as well, so a violation created from the
UI lands in the same tracking issue.

Under `make pre-push`, a diff-mode gate makes **no tracker call** when the
change adds, removes and closes nothing, so a typical pre-push needs no network.
An MR pipeline is different: each of the five gates makes one `closes_issues`
call to learn the closing set, and then issue-state lookups only for the
references the change adds or closes.

## The nightly report

> **Operator step required.** The report cannot write anything until someone
> creates `TRACKER_DRIFT_TOKEN` as a **masked, protected** CI/CD variable: a
> project access token with `api` scope and Reporter role or higher. Until it
> exists, the job fails on the first write it needs, and its error message
> names this step. Creating it is tracked in #4927.

`tracker:drift-report` (`scripts/tracker-drift-report.sh`) runs on the existing
nightly SonarCloud schedule (`SONAR_SCHEDULED=true`), so no new schedule and no
second full schedule pipeline is needed. The job runs every gate in drift
mode and updates the issue titled *Tracker drift: repo references out of sync
with the issue tracker* (label `tracker-drift`):

| Report | Tracking issue | Action |
|---|---|---|
| drift | none | create it |
| drift | exists, findings changed | rewrite the description, and reopen it if it is closed |
| drift | exists, findings unchanged | nothing. A digest in the description is compared, so an unchanged night posts nothing |
| clean | open | close it with a note |
| clean | none open | nothing |

The job stays **green on drift**: the tracking issue is the durable signal, and
a red schedule that no commit can fix trains people to ignore red. It goes
**red** when any gate cannot read the tracker. That is fail closed, and the
issue is left untouched, because an incomplete report must not close a valid
tracking issue. It also goes red when a tracker write fails, or when a write is
needed and no write token is set.

### Tokens

- Reads use `ISSUES_API_TOKEN` (`read_api`), the same token as the gates. The
  job token is never sent to the Issues or MR API (#3043).
- Writes use `TRACKER_DRIFT_TOKEN` (creating it is tracked in #4927), a masked, protected project access token
  with `api` scope and Reporter role or higher. It is sent only as a request
  header and is never echoed. The self-test asserts that it does not reach the
  job log.

### Main push pipelines

A main push runs the gates in diff mode against `CI_COMMIT_BEFORE_SHA`. It
catches a direct push to main (the release commit) that adds a stale
reference. It does not catch drift. Nothing is `allow_failure`: a failed
`allow_failure` job is invisible in the pipeline status, which is the silence
these gates exist to remove.

## Exit codes

`0` means clean, `1` means a rule failed, and `2` means an invocation error.
`3` means the tracker or the diff base was unreadable, and the gate failed
closed. `check-suppression-issues.sh` keeps its historical `2` for that case.
Each gate's `*_ALLOW_UNRESOLVED=1` is the explicit opt-out, and it is not set
in CI.
