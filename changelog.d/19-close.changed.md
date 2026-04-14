Close live-impact-simulation (#19) on the native-TypeScript Gantt drag-preview
worker. ADR-0015 amendment ratifies the shipped path; the Rust WASM build at
`packages/wasm-scheduler/` stays green as the conformance reference and
migration target. New vitest perf guard asserts the 1000-task FS-chain preview
stays under 33 ms p95 — failing this test is the signal to execute the WASM
migration documented in the ADR. (#19)
