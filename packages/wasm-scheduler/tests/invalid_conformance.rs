//! Cross-engine reject parity (#749).
//!
//! Every fixture under `fixtures/invalid/` parses cleanly but is structurally
//! degenerate — the Python engine raises `InvalidScheduleInput` on each (see
//! `packages/scheduler/tests/test_wasm_conformance.py::test_invalid_fixture_rejected`).
//! The Rust engine must reject the same set, returning `Err` rather than
//! spinning the calendar walk or panicking on `chrono` date overflow.

use std::fs;
use std::path::PathBuf;

use trueppm_wasm_scheduler::models::Project;
use trueppm_wasm_scheduler::schedule_impl;

fn invalid_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures").join("invalid")
}

fn assert_rejected(name: &str) {
    let path = invalid_dir().join(format!("{name}.json"));
    let json = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{name}: failed to read fixture: {e}"));
    // Must parse — these are rejected at schedule time, not at parse time.
    let project: Project = serde_json::from_str(&json)
        .unwrap_or_else(|e| panic!("{name}: fixture should parse, got {e}"));
    assert!(
        schedule_impl(&project).is_err(),
        "{name}: expected schedule_impl to reject degenerate input, got Ok"
    );
}

#[test]
fn rejects_zero_working_days() {
    assert_rejected("zero_working_days");
}

#[test]
fn rejects_duration_over_max() {
    assert_rejected("duration_over_max");
}

#[test]
fn rejects_negative_duration() {
    assert_rejected("negative_duration");
}

#[test]
fn rejects_lag_over_max() {
    assert_rejected("lag_over_max");
}

#[test]
fn rejects_project_span_over_max() {
    assert_rejected("project_span_over_max");
}

#[test]
fn rejects_blanket_exceptions() {
    // Valid weekday mask, but `exceptions` cover the entire representable date
    // range — no working day is reachable from the project start. Both engines
    // reject this at the validation layer (#749). The Python conformance suite
    // (test_invalid_fixture_rejected) asserts the same fixture on both schedule()
    // and monte_carlo().
    assert_rejected("blanket_exceptions");
}

#[test]
fn rejects_duplicate_task_id() {
    // Two tasks share an id. Per-task results are keyed on id, so a duplicate
    // silently shadows one task; both engines reject it at validation (#749).
    assert_rejected("duplicate_task_id");
}
