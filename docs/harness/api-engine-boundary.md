# API engine boundary (`lint:api-engine-boundary`)

**Rule (#4688).** Every sampled, scheduled, or derived value the API serves is computed by
a call into `trueppm_scheduler` (or `wasm-scheduler` under conformance). The API may
select, filter, cache, paginate and serialize engine output. It may not sample, expand,
snap, floor or aggregate durations or dates itself. The engine's oracle, mutation score
and parity guarantees stop at the library boundary, so anything recomputed on the API side
is unverified. #2645, #4663 and #4660 were three hand-found instances of the same class.
This is the engine-side complement of ADR-0599 (API-first).

## The gate

`scripts/check-api-engine-boundary.py` (CI job `lint:api-engine-boundary`, `make
api-engine-boundary-check`, part of `make pre-push`) scans code tokens in
`packages/api/src/trueppm_api` for four spellings: `np.random`/`default_rng`,
`random.<fn>(`, `np.percentile`/`np.quantile`, and `timedelta(days=` (minus now-cutoffs,
week snaps, constants and `lag=`/`duration=` engine-input construction). It runs its own
`--self-test` first, which plants a violation and requires the gate to fail on it.

It does **not** see semantics: hand-rolled `d += 1` calendar walks, float/criticality
derivation and rollup math are invisible to it. The one-time audit inventory on #4688
covers those; the summary-task `total_float` rollup is tracked in #5010; the header of the script lists every blind spot.

Further blind spots: aliased imports (`import statistics as st; st.quantiles(...)`), and
`cutoff`/`retention`/`window` timedelta lines count as clock bookkeeping only when
`now`/`today` is on the same line. `# engine-boundary-ok: <reason>` may sit on the line or
the comment line directly above.

## The allow-list

`packages/api/api-engine-boundary-allowlist.txt`: `path | rule | max-count | issue | reason`.
It is a ceiling that can only shrink. A count above the entry fails (new hit); a count
below it fails too, until you lower the number. An entry matching nothing fails. Each entry
names an open issue as `#NNNN`; the gate does not query the tracker.

## When it fails

1. Replace the computation with a library call, or move it into `trueppm_scheduler` behind a
   public function and call that.
2. If it is genuinely not engine math (a timesheet date bound, a retention cutoff), add
   `# engine-boundary-ok: <reason>` on the line. The reason is required; it is a rubber
   stamp that removes the silence, like `# layering-ok:`.
3. Otherwise add an allow-list entry with an issue. Do not raise an existing count to get
   green.
