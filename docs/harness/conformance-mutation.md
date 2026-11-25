# Conformance-scoped mutation score (#2637)

The Python and Rust CPM engines are bound to each other by the shared fixtures in
`packages/wasm-scheduler/fixtures/` and the committed oracle corpus. Each engine is
checked against that corpus from its own side (`wasm:conformance`, `wasm:test`). A
Python change in a region no fixture covers passes both and the engines diverge.

`packages/scheduler/scripts/conformance_mutation.sh` measures that. It runs mutmut
over `*/engine/*.py` (or the globs passed as arguments) in a scratch copy, with only
`tests/test_wasm_conformance.py` as the kill suite. A surviving mutant is a Python
behavior change the fixtures would not notice. It is non-gating and exits 0. It is not
wired into CI: the full engine is ~9,700 mutants (about 10 minutes on a laptop), so
decide on a nightly slot before adding one.

## Result, 2026-11-25 (main at 2753c69d2, mutmut 3.8.0)

| | Mutants |
|---|---|
| Killed (incl. 10 timeouts) | 3,128 |
| Survived | 1,920 |
| No test reaches the mutant | 4,656 |
| Total | 9,704 |

The first draft of this table said 9,714; its rows sum to 9,704 and the 10-mutant
difference could not be attributed from the recorded output (mutmut's timeout,
suspicious and skipped statuses are not broken out), so the total is the row sum.

Score `killed / (killed + survived)` = **62.0%**. The unreached 4,656 are a coverage
gap, not an assertion gap, and are excluded from the score the same way
`check_mutation_score.py` excludes them.

Survivors by module: `montecarlo/run` 615, `validate` 400, `montecarlo/index` 233,
`montecarlo/sampling` 231, `milestones` 146, `calendar_math` 112, `backward` 79,
`forward` 44, `cpm` 33, `graph` 18, `digraph` 8, `errors` 1.

Read it by module, not as one number. Monte Carlo and `validate` are not what the
conformance fixtures are meant to bind (validation is held by `invalid/` and
`parse_rejects/`; Monte Carlo is not offline-recomputed in Rust), so their survivors
are mostly noise for this question. The CPM core is the cross-engine contract:
`milestones`, `calendar_math`, `backward`, `forward`, `cpm`, `graph` carry 432
survivors. `calendar_math` alone scores 335/447 = 74.9% (130 more unreached).

## What this does not measure

Class B: both engines share one misreading of the spec. Snapshots are generated from
Python, so a mutant that moves the engine toward the spec would score as killed.
Only a spec-anchored test in each engine's own suite covers that class.

## Not done

The issue's later items (triage each survivor, add fixtures, decide whether the score
becomes a tracked number) are open. Run the script with one module's glob, for example
`'*/engine/milestones.py'`, then `mutmut results` in the printed scratch directory
(kept only for the run) to list survivors.
