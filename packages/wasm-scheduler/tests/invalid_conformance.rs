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
use trueppm_wasm_scheduler::{
    compute_schedule, incremental_checked, schedule_checked, schedule_impl, ErrorKind,
};

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

/// #4474: every rejection carries a structured kind. A degenerate input is
/// `invalid_input`, `cycle`, or — for a calendar whose exceptions leave no
/// working day for a pass to land on — `schedule`; never `parse` or
/// `unknown_task`. Only a `cycle` carries a cycle chain.
#[test]
fn invalid_fixtures_reject_with_a_structured_kind() {
    let dir = fixtures_dir().join("invalid");
    for stem in &json_stems(&dir) {
        let json = fs::read_to_string(dir.join(format!("{stem}.json"))).unwrap();
        let project: Project = serde_json::from_str(&json).unwrap();
        let err = schedule_checked(&project).expect_err(stem);
        let kind = err.error_kind();
        assert!(
            matches!(
                kind,
                ErrorKind::InvalidInput | ErrorKind::Cycle | ErrorKind::Schedule
            ),
            "{stem}: unexpected kind {kind:?} ({err})"
        );
        assert_eq!(
            kind == ErrorKind::Cycle,
            err.cycle_chain().is_some(),
            "{stem}: a cycle chain must come with, and only with, kind cycle"
        );
        // The message is the one `schedule_impl` has always returned.
        assert_eq!(schedule_impl(&project).unwrap_err(), err.to_string(), "{stem}");
    }
    let json = fs::read_to_string(dir.join("cycle.json")).unwrap();
    let project: Project = serde_json::from_str(&json).unwrap();
    assert_eq!(
        schedule_checked(&project).unwrap_err().error_kind(),
        ErrorKind::Cycle
    );
}

/// #4474: a cyclic input yields kind `cycle` with the full canonical chain —
/// the same chain the Python engine reports on `CyclicDependencyError.cycle`,
/// pinned by the shared `cycle_errors/expected/` snapshots.
#[test]
fn cycle_error_carries_the_canonical_chain() {
    let dir = fixtures_dir().join("cycle_errors");
    let stems = json_stems(&dir);
    assert!(!stems.is_empty());
    for stem in &stems {
        let project: Project =
            serde_json::from_str(&fs::read_to_string(dir.join(format!("{stem}.json"))).unwrap())
                .unwrap();
        let expected: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(dir.join("expected").join(format!("{stem}.json"))).unwrap(),
        )
        .unwrap();
        let want: Vec<String> = serde_json::from_value(expected["cycle"].clone()).unwrap();
        for err in [
            schedule_checked(&project).unwrap_err(),
            incremental_checked(&project, &project.tasks[0].id).unwrap_err(),
        ] {
            assert_eq!(err.error_kind(), ErrorKind::Cycle, "{stem}");
            assert_eq!(err.kind(), "cycle", "{stem}");
            assert_eq!(err.cycle(), Some(want.clone()), "{stem}");
            assert_eq!(err.message(), expected["message"].as_str().unwrap(), "{stem}");
        }
    }
}

/// #4474: the JS entry point itself distinguishes malformed JSON (`parse`) from a
/// project that parsed but is not schedulable (`invalid_input`), and an unknown
/// changed task (`unknown_task`) from both.
#[test]
fn entry_points_classify_parse_input_and_unknown_task() {
    let err = compute_schedule("{not json").unwrap_err();
    assert_eq!(err.kind(), "parse");
    assert_eq!(err.cycle(), None);
    assert!(err.to_js_string().starts_with("parse: "));

    let dir = fixtures_dir().join("parse_rejects");
    for stem in &json_stems(&dir) {
        let json = fs::read_to_string(dir.join(format!("{stem}.json"))).unwrap();
        assert_eq!(compute_schedule(&json).unwrap_err().kind(), "parse", "{stem}");
    }

    let empty = r#"{"id":"p","name":"p","start_date":"2026-04-01","tasks":[],"dependencies":[]}"#;
    assert_eq!(compute_schedule(empty).unwrap_err().kind(), "invalid_input");

    let valid = fs::read_to_string(fixtures_dir().join("basic_fs_chain.json")).unwrap();
    let project: Project = serde_json::from_str(&valid).unwrap();
    let err = incremental_checked(&project, "GHOST").unwrap_err();
    assert_eq!(err.error_kind(), ErrorKind::UnknownTask);
    assert_eq!(err.kind(), "unknown_task");
}
