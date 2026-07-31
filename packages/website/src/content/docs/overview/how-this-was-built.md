---
title: How this was built
description: TruePPM is developed with heavy AI assistance and held to a harness that assumes the author — human or model — is unreliable. What actually blocks a merge, the practices that are unusual, the limits we will not paper over, and how to verify all of it yourself.
---

TruePPM is written with heavy AI assistance. That is worth saying plainly, because
it is the first thing a careful evaluator should want to know, and because the
honest answer is not "and therefore you should trust it." It is: **an
AI-assisted codebase has to prove itself more than a hand-written one, not less.**

A language model will produce code that compiles, reads well, and is wrong. It will
write a test that executes a line without asserting anything meaningful about it. It
will confidently reintroduce a bug that was fixed six months ago because nothing in
the file explained why the odd-looking line was odd on purpose. None of those failure
modes are hypothetical — every one of them has happened in this repository, and the
harness described below exists because of it.

So the design premise is simple: **assume the author is unreliable and build gates
that do not care who wrote the code.** A gate that only works when the author is
careful is not a gate. This page is the evidence, the limits, and the commands to
check both.

:::note[Related pages]
This page is the *why* and the evidence. For the practical how-to — running the
suites, coverage measurement, what is excluded from the denominator and why — see
[Testing & quality](/contributing/testing/).
:::

## What actually blocks a merge

Claims about quality are cheap. This is the enforced list — a merge request that
fails any of these cannot merge, because GitLab is configured with
`only_allow_merge_if_pipeline_succeeds`:

| Gate | What it proves |
| --- | --- |
| **Lint / format** | ruff (incl. `ruff format --check`) and eslint across every package. |
| **Type check** | `mypy --strict` on all Python, `tsc --noEmit` on all TypeScript. No `any`. |
| **Test suites** | pytest (API, scheduler, MCP), vitest, Playwright — all must pass. |
| **Per-package coverage floors** | 80% on the scheduler, MCP, and API packages. |
| **Diff coverage** | New and changed lines in the MR must be covered — not just the package average. |
| **New-file coverage presence** | A file added in the MR must appear in the coverage report at all, closing the "brand-new untested file" dodge. |
| **Test-collection integrity** | Every test file on disk must actually be collected by the command CI runs. |
| **Migration check** | `makemigrations --check` proves the committed migrations fully describe the models. |
| **Schema drift** | The committed OpenAPI schema matches the current code. |
| **Accessibility** | axe-core WCAG 2.1 A/AA scan inside the E2E suite; critical and serious violations fail. |
| **Security** | OSV, gitleaks, semgrep, trivy, bandit, SBOM, and license compatibility. |
| **License boundary** | The Apache-2.0 core is verified to contain zero imports from the enterprise repo. |
| **Changelog fragment** | A source change without a changelog entry fails the pipeline. |

Roughly 89 CI jobs across lint, analyze, test, security, publish, and deploy stages.

## Four things that are not standard practice

Most projects with a green pipeline have some version of the table above. These four
are the ones worth pointing at, because each was written *after* a specific failure
and each targets a way a test suite can be reassuring and useless at the same time.

### 1. The harness tests itself

For a long stretch, the web test command carried a positional path filter. It looked
harmless. Its effect was that every spec outside a handful of directories — workers,
utilities, the root application test — **silently never ran in CI**. Nothing failed.
The pipeline was green the entire time. The tests existed, were maintained, and were
not executed.

There is now a gate whose only job is to assert that every test file on disk is
collected by the exact command CI invokes. It runs at pipeline start, independent of
the slow shards, so a reintroduced filter fails in seconds.

Two sibling gates cover the same class of invisible failure: one fails if a file
added in a merge request never enters the coverage report at all, and one fails the
report job if any test passed *only on retry*. The gate scripts themselves have unit
tests.

### 2. Hermeticity is enforced, not assumed

A test that reaches the real network is not a test — it is a fixture that happens to
pass on your machine today. The concrete incident: a misdirected mock let a test make
a genuine 10-second connection to a cloud metadata address. It did not fail. It hung,
and then flaked depending on test ordering.

Every API test now runs with outbound sockets banned. The allowlist is *derived from
Django settings* rather than hardcoded, so it is identical in CI and on a laptop, and
each host is resolved to its IP addresses because the underlying tool matches the
address actually passed to `connect()`. A test that genuinely needs the network opts
out with an explicit, reviewable marker. Everything else fails instantly and
deterministically at author time.

### 3. A flake is a bug until proven otherwise

This is the practice that has paid off most, and it is mostly a cultural rule with
tooling behind it.

The tempting response to an intermittent E2E failure is to retry it. The last four
intermittent failures investigated here were **three real product bugs and one real
harness defect** — none was runner noise. A Space-and-drag pan that silently died
whenever the board rendered its loading skeleton first. A status badge hidden by a
disclosure rule. A page that crashed on a malformed mock and tore the app down
mid-click. Each initially looked like infrastructure flakiness. Each was a defect a
user would have hit.

So the tooling makes flakes visible rather than absorbing them:

- CI allows exactly **one** retry — enough to absorb a genuine runner blip, not
  enough to let a test that fails two of three attempts report success. Locally the
  retry count is **zero**.
- Any test that passed only on retry fails a dedicated reporting job. A retry never
  masks anything silently.
- Reduced motion is emulated suite-wide, because a looping loading skeleton keeps the
  layout permanently in motion and defeats the test runner's stability check —
  surfacing as an inexplicable timeout on an unrelated control.
- A helper exists specifically to *delay* API responses, forcing components to render
  their loading state first. Without it the cold-load path — the one real users
  actually get — is only ever covered by accident.
- A lint gate requires every mocking spec to register a catch-all route, so a missing
  mock produces a named warning instead of behavior that differs between a developer
  machine and CI.

### 4. Configuration carries its reasons

This is the part with the most direct bearing on AI-assisted development.

An unexplained line is an invitation to "simplify" it. A model refactoring a file it
has never seen before will happily delete a workaround it cannot see the purpose of —
and so, frankly, will a human six months later. The countermeasure is that non-obvious
settings in this repository carry the incident that produced them.

Why the retry count is one and not two. Why the test host is pinned to an IPv4 literal
rather than `localhost` — because on macOS the name resolves to IPv6 first and the
readiness probe then never connects, while Linux CI happens to work and hides it. Why
a particular generation health-check is suppressed in the fuzz job, including what was
bisected to prove the suppression costs no coverage. Why the root pytest configuration
sits where it does rather than one directory down.

These comments are not decoration. They are the mechanism that stops a confident
editor — of any kind — from regressing a fix by removing something that looked untidy.

## Beyond "did the test run?"

Coverage answers whether a line executed. It cannot answer whether a test would fail
if that line were wrong. Three techniques address the gap, weighted toward the
scheduling engine because it is the core IP:

- **Property-based testing** generates thousands of inputs and checks invariants that
  must always hold — a task never starts before its predecessor finishes, float is
  never negative — instead of a handful of hand-picked examples.
- **Contract fuzzing** drives every documented API operation with generated input and
  flags any unhandled 500 or response that violates the published OpenAPI schema.
- **Mutation testing** deliberately corrupts the source — flips a comparison, negates
  a boolean — and reruns the suite. A mutant that *survives* names the exact assertion
  the tests are missing.

Two independent implementations of the scheduling engine — the Python library and the
Rust engine compiled to WebAssembly for offline recompute — are held in conformance
against shared fixtures, so offline results match server results.

## Who decides what gets built

Everything above is about whether the code works. A separate half of the harness decides
what gets written in the first place, and it deserves the same scrutiny — arguably more,
because its failure modes are quieter. A test suite that is wrong goes red. A product
process that is wrong just produces confident, well-tested software nobody asked for.

That half is also AI-run: design review, UX review, security, RBAC, performance, and
migration gates are agent passes over the diff, defined in `.claude/skills/` and readable
in the repository alongside the code. Two properties of it are worth stating plainly,
because a reader should not have to discover them.

### The customer panel is simulated

Feature work is reviewed by a "voice of customer" panel of eleven personas — a delivery
manager, a PMO director, a self-hosting operator, and so on. **None of them is a real
person, and none was derived from an interview, a survey, or a usability session.** They
are composite hypotheses written from domain knowledge of the P3M market, and they are
labeled as such in `.claude/personas.md`, where every persona currently carries grounding
tier **T0: modeled, no contact with a real user of this product.**

Using modeled personas before launch is reasonable — there is no alternative when the
user count is zero, and arguing a feature from a specific point of view beats arguing it
from the builder's own. Presenting the result as customer research would not be
reasonable, so the harness makes that hard: panel output carries a provenance banner,
every blocker must state the real-world observation that would refute it, and the panel
average is explicitly barred from authorizing a shipping decision. A high score is
treated as a warning that the panel may be restating its own brief, not as a green light.

The honest summary is that **the product decisions behind this beta were made without
users.** 0.4 will be the first release to reach any, and from that point a calibration
pass reconciles what the panel predicted against what users actually report, recorded in
`.claude/persona-calibration.md`: hits, misses, and false alarms, with misses reported
first. A persona's grounding tier can only be raised there, by citing a specific real
report. Those hit rates will be an upper bound — people who evaluate TruePPM, find it
unsuitable, and leave without saying anything are invisible to the method, and they are
exactly the group the personas are most likely to be wrong about.

### Gate yield is measured, so gates can be removed

A review gate that runs on every change and never finds anything looks like diligence and
behaves like tax. It is also invisible to the obvious metric: measuring how often a gate
is *skipped* says nothing about a gate that always runs and always passes.

So merge requests carry a machine-readable ledger of which gates ran and how many
findings each produced — including, and especially, the zeros. A gate at zero yield over
enough runs is a gate whose scope should narrow. This has already retired real ceremony:
architecture and UX-design review were dropped from routine settings sub-page work after
they were found to be producing nothing on that class of change. The measurement exists
so that finding is a table rather than a year of accumulated habit.

The obvious limitation: the ledger is self-reported by the agent that ran the gate. It is
honest-effort data, not instrumentation, and it cannot detect a gate whose findings were
real but recorded as none.

## The limits

Any page like this that lists only strengths is marketing. These are the current gaps,
stated because an evaluator will find them anyway and should find them here first:

- **The E2E suite is mock-heavy.** 230 specs run against the built app with the API
  mocked at the browser; only a handful exercise a live Django, PostgreSQL, and Valkey
  stack. Mocked specs structurally cannot catch API contract drift — that load is
  carried by the schema-drift gate and the nightly contract fuzzing, which is a
  narrower net than real end-to-end coverage.
- **The strongest checks do not block merges.** Mutation testing, contract fuzzing,
  and load testing run nightly and are explicitly allowed to fail. This is deliberate
  — the nightly pipeline is shared, and a red run there would train maintainers to
  ignore red — but it does mean these are triage signals, not gates.
- **The accessibility gate is a foothold, not full compliance.** It fails on critical
  and serious WCAG violations globally; `moderate` findings are being ratcheted in
  route by route as each surface's audit fixes land. The commitment is WCAG 2.1 AA;
  the enforced floor has not reached it everywhere yet.
- **One browser.** E2E runs on Chromium only, to keep CI time reasonable. Firefox and
  WebKit are not yet covered.
- **Coverage instrumentation is deliberately narrowed.** Instrumenting the entire
  frontend source tree would drag historical untested surface into the denominator and
  push the reported number below the enforced floor. The two compensating gates
  described above exist precisely because that base configuration is a compromise. It
  is honest debt, not a solved problem.
- **No feature in this release was validated with a real user.** The persona panel
  described above is simulated, every persona is grounding tier T0, and the calibration
  ledger that will score it against reality is empty because there is nothing yet to
  score. The engineering evidence on this page is strong; the product evidence is a set
  of stated, falsifiable assumptions. Do not read the first as support for the second.
- **The process gates are weaker evidence than the code gates.** Everything in the first
  table is enforced by CI and fails a pipeline. The design, UX, and review gates are
  agent passes with a documented fast path and a documented skip, and their yield is
  self-reported. They are a discipline, not a mechanism, and a discipline is only as good
  as the last time it was checked.
- **This is alpha software.** The latest tagged release is `0.3.0-alpha.3`, and 0.4 is
  planned as the first beta. A rigorous harness is not the same as a mature product,
  and nothing on this page should be read as claiming otherwise.

## Verify it yourself

Nothing above requires taking our word for it. The repository is public and every
claim is checkable:

```bash
git clone https://gitlab.com/trueppm/trueppm.git
cd trueppm

# Every gate the CI pipeline runs, and its configuration
cat .gitlab-ci.yml

# The gates that block a merge, run locally
make lint typecheck test
make pre-push

# The harness's own gates — and their tests
ls packages/web/scripts/

# The process half: the review gates, the personas, and their calibration record
ls .claude/skills/
cat .claude/personas.md
cat .claude/persona-calibration.md

# Count what exists
find packages/api/tests packages/scheduler/tests -name 'test_*.py' | wc -l
find packages/web/src -name '*.test.ts*' | wc -l
ls packages/web/e2e/*.spec.ts | wc -l
```

At the time of writing that is roughly 1,400 test files carrying about 16,600
individual tests. The number will have moved by the time you run it; the point is
that it is a command, not a claim.

For the mechanics of the suites and the coverage methodology, continue to
[Testing & quality](/contributing/testing/). For the design commitments the code is
written against, see [Guiding principles](/overview/principles/).
