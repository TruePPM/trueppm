Raise API test coverage gate from 65% to 80% (current: 89%). Add
`scheduler:bench` CI job with 100- and 500-task timing benchmarks (hard
limit 2s) — artifact stored for regression comparison. Add Playwright
`auth.spec.ts` (login happy path, 401 error, network error) and
`view-switching.spec.ts` (Gantt/WBS/Board/Table navigation, deep-link,
round-trip). Closes web+API scope of #42; mobile Detox tracked separately.
(#42)
