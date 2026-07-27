//! Cross-engine reject parity (#749) and Rust-only input rejection (#1505).
//!
//! `fixtures/invalid/` — every file parses cleanly but is structurally
//! degenerate; the Python engine rejects each (see
//! `packages/scheduler/tests/test_wasm_conformance.py::test_invalid_fixture_rejected`),
//! and the Rust engine must return `Err` rather than spin the calendar walk or
//! panic on a `chrono` date overflow. Both suites iterate the directory (#1505),
//! so a new adversarial fixture is auto-checked by both engines.
//!
//! There is deliberately no `rust_rejects/` directory any more. It existed for
//! inputs that were *valid for Python* but which the Rust engine could not
//! faithfully honor — in practice only per-task calendars (ADR-0120 D3). With
//! #1504 the Rust engine honors those, so the last one-sided rejection is gone
//! and its fixture was promoted into the ordinary two-engine conformance set
//! (`fixtures/per_task_calendar_six_day.json`). Re-introducing a Rust-only
//! rejection would be a parity regression: prefer implementing the semantics.
//!
//! `fixtures/parse_rejects/` — documents that must fail *deserialization* in
//! both engines (#1861): dates in lenient ISO-8601 forms (compact `20260401`,
//! week-date `2026-W15-1`, ordinal `2026-092`) that chrono's `%Y-%m-%d`
//! `NaiveDate` serde never accepted and that Python now rejects with a strict
//! `YYYY-MM-DD` pre-check. They cannot live in `invalid/` because that suite
//! requires every fixture to parse; these by design do not. The Python side is
//! `test_wasm_conformance.py::test_parse_reject_fixture_rejected_at_parse`.

use std::fs;
use std::path::PathBuf;

use trueppm_wasm_scheduler::models::Project;
use trueppm_wasm_scheduler::schedule_impl;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

fn json_stems(dir: &PathBuf) -> Vec<String> {
    let mut stems: Vec<String> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", dir.display()))
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(String::from))
        .collect();
    stems.sort();
    stems
}

/// Every `fixtures/invalid/*.json` must be rejected by `schedule_impl` (#749).
/// Iterating the directory (rather than a static list) means a new invalid
/// fixture added on the Python side is automatically enforced here too (#1505).
#[test]
fn all_invalid_fixtures_rejected() {
    let dir = fixtures_dir().join("invalid");
    let stems = json_stems(&dir);
    assert!(
        !stems.is_empty(),
        "no invalid fixtures found in {} — path break? (#1506)",
        dir.display()
    );

    for stem in &stems {
        let path = dir.join(format!("{stem}.json"));
        let json = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{stem}: failed to read fixture: {e}"));
        // Must parse — these are rejected at schedule time, not at parse time.
        let project: Project = serde_json::from_str(&json)
            .unwrap_or_else(|e| panic!("{stem}: fixture should parse, got {e}"));
        assert!(
            schedule_impl(&project).is_err(),
            "{stem}: expected schedule_impl to reject degenerate input, got Ok"
        );
    }
}

/// Every `fixtures/parse_rejects/*.json` must fail deserialization (#1861).
/// These carry dates in lenient ISO-8601 forms (compact / week-date / ordinal)
/// that Python's `date.fromisoformat` used to accept while chrono's `%Y-%m-%d`
/// serde rejects — a silent cross-engine divergence. Both engines now reject
/// them at parse time; iterating the directory means a new lenient-form fixture
/// added on either side is automatically enforced in both engines.
#[test]
fn parse_reject_fixtures_fail_to_deserialize() {
    let dir = fixtures_dir().join("parse_rejects");
    let stems = json_stems(&dir);
    assert!(
        !stems.is_empty(),
        "no parse_rejects fixtures found in {} — path break? (#1506)",
        dir.display()
    );

    for stem in &stems {
        let path = dir.join(format!("{stem}.json"));
        let json = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{stem}: failed to read fixture: {e}"));
        assert!(
            serde_json::from_str::<Project>(&json).is_err(),
            "{stem}: expected deserialization to reject a non-canonical (non-YYYY-MM-DD) \
             date form, got Ok (#1861)"
        );
    }
}
