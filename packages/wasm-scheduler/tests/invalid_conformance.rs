//! Cross-engine reject parity (#749) and Rust-only input rejection (#1505).
//!
//! `fixtures/invalid/` — every file parses cleanly but is structurally
//! degenerate; the Python engine rejects each (see
//! `packages/scheduler/tests/test_wasm_conformance.py::test_invalid_fixture_rejected`),
//! and the Rust engine must return `Err` rather than spin the calendar walk or
//! panic on a `chrono` date overflow. Both suites iterate the directory (#1505),
//! so a new adversarial fixture is auto-checked by both engines.
//!
//! `fixtures/rust_rejects/` — inputs that are *valid for Python* but which the
//! Rust engine cannot faithfully honor (per-task calendars, agile Monte Carlo
//! fields). With `#[serde(deny_unknown_fields)]` on the input structs (#1505),
//! Rust must reject these at parse time rather than silently schedule on the
//! wrong calendar. These are one-sided (Rust-only) rejections, so they live
//! outside `invalid/` and Python never loads them.

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

/// Every `fixtures/rust_rejects/*.json` is valid for the Python engine but must
/// be rejected by Rust because it *sets* a field this engine cannot honor
/// (per-task calendars, ADR-0120 D3). Since #1816 these fields are *parsed* (so the
/// canonical `Project.to_json()` output — which emits them as `null` — is accepted),
/// so the rejection moved from parse time (`deny_unknown_fields`) to schedule time
/// (`validate_project`). The fixture parses cleanly and `schedule_impl` returns
/// `Err` — the honest alternative to silently scheduling on the wrong calendar.
#[test]
fn rust_rejects_unhonorable_inputs() {
    let dir = fixtures_dir().join("rust_rejects");
    let stems = json_stems(&dir);
    assert!(
        !stems.is_empty(),
        "no rust_rejects fixtures found in {} — path break? (#1506)",
        dir.display()
    );

    for stem in &stems {
        let path = dir.join(format!("{stem}.json"));
        let json = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{stem}: failed to read fixture: {e}"));
        // Parses (the Python-only keys are now declared, #1816) but is rejected at
        // schedule time because it *sets* a per-task calendar this engine can't honor.
        let project: Project = serde_json::from_str(&json)
            .unwrap_or_else(|e| panic!("{stem}: fixture should parse since #1816, got {e}"));
        assert!(
            schedule_impl(&project).is_err(),
            "{stem}: Rust must reject an input that sets a per-task calendar it cannot \
             honor — it would otherwise silently schedule on the wrong calendar (#1505/#1816)."
        );
    }
}
