//! Native line-protocol driver for the reference-CPM properties (#3987).
//!
//! Reads one `Project.to_json()` document per stdin line and writes one JSON line
//! per input to stdout: `{"ok": <ScheduleResult>}` or `{"err": "<message>"}`.
//! `packages/scheduler/tests/test_cpm_oracle.py` keeps one of these processes
//! open and feeds it Hypothesis-generated networks, so the Rust engine is held to
//! the independent reference without a WASM runtime. Test tooling only — it is
//! not part of the published crate (`Cargo.toml` `include` ships `src/` alone).

use std::io::{self, BufRead, Write};

use trueppm_wasm_scheduler::models::Project;
use trueppm_wasm_scheduler::schedule_impl;

fn main() {
    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.expect("stdin must be readable UTF-8");
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Project>(&line) {
            Err(e) => serde_json::json!({ "err": e.to_string() }),
            Ok(project) => match schedule_impl(&project) {
                Ok(result) => serde_json::json!({ "ok": result }),
                Err(e) => serde_json::json!({ "err": e }),
            },
        };
        writeln!(out, "{reply}").expect("stdout must be writable");
        out.flush().expect("stdout must be writable");
    }
}
