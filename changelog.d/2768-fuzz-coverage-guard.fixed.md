The nightly API fuzz job now fails when an operation was never fuzzed, rather than
reporting 580 of 581 operations green. `POST /projects/{id}/tasks/bulk/` had been
silently exempt from contract fuzzing since 2026-08-04 because a Schemathesis health
check aborts generation for an operation instead of reducing it.
