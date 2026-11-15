//! The structured error every JS entry point throws (#4474).
//!
//! Every entry point used to throw a bare string, so a JS caller could tell a
//! cycle from invalid input from malformed JSON only by matching message text,
//! and never got the cycle itself. Once the package is published (#948) the
//! messages would have become the contract. A [`SchedulerError`] carries a
//! stable machine-readable `kind`, the human `message`, and — for a cycle — the
//! cycle chain, mirroring the Python engine's `CyclicDependencyError.cycle`.
//!
//! The `kind` strings are the contract; the messages are not and may change.

use wasm_bindgen::prelude::*;

use crate::graph::GraphBuildError;

/// What went wrong, as one of a fixed set of categories. Rendered to JS as the
/// lowercase string [`ErrorKind::as_str`] returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// The input JSON did not parse, or did not match the project schema
    /// (an unknown field, a malformed date). `"parse"`.
    Parse,
    /// The project parsed but is not schedulable as given: empty, a value out of
    /// range, a dependency naming a task that does not exist. Mirrors the Python
    /// `InvalidScheduleInput`. `"invalid_input"`.
    InvalidInput,
    /// The dependency graph has a cycle; [`SchedulerError::cycle`] holds it.
    /// Mirrors the Python `CyclicDependencyError`. `"cycle"`.
    Cycle,
    /// A task id passed to a session or incremental call (the dragged or changed
    /// task) is not in the project. `"unknown_task"`.
    UnknownTask,
    /// Validation accepted the project but a CPM pass could not complete it, such
    /// as a calendar walk that ran out of working days within its bound.
    /// `"schedule"`.
    Schedule,
}

impl ErrorKind {
    /// The stable JS-facing name of this kind.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Parse => "parse",
            ErrorKind::InvalidInput => "invalid_input",
            ErrorKind::Cycle => "cycle",
            ErrorKind::UnknownTask => "unknown_task",
            ErrorKind::Schedule => "schedule",
        }
    }
}

/// A scheduler failure as JS sees it: `{ kind, message, cycle }`.
///
/// Thrown by every fallible entry point. `kind` is one of `"parse"`,
/// `"invalid_input"`, `"cycle"`, `"unknown_task"`, `"schedule"`. `cycle` is the
/// full canonical cycle (first id repeated at the end) when `kind` is
/// `"cycle"`, and `undefined` otherwise; the message shows a bounded prefix of
/// it, the property is never truncated.
#[wasm_bindgen]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchedulerError {
    kind: ErrorKind,
    message: String,
    cycle: Option<Vec<String>>,
}

#[wasm_bindgen]
impl SchedulerError {
    /// The error category — see the type documentation for the values.
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> String {
        self.kind.as_str().to_string()
    }

    /// The human-readable message. Not a stable contract; branch on `kind`.
    #[wasm_bindgen(getter)]
    pub fn message(&self) -> String {
        self.message.clone()
    }

    /// The cycle chain for a `"cycle"` error, else `undefined`.
    #[wasm_bindgen(getter)]
    pub fn cycle(&self) -> Option<Vec<String>> {
        self.cycle.clone()
    }

    /// `"<kind>: <message>"`, so an error that reaches a log or a template
    /// string still reads as text.
    #[wasm_bindgen(js_name = toString)]
    pub fn to_js_string(&self) -> String {
        format!("{}: {}", self.kind.as_str(), self.message)
    }
}

impl SchedulerError {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        SchedulerError {
            kind,
            message: message.into(),
            cycle: None,
        }
    }

    /// A JSON parse or schema failure.
    pub(crate) fn parse(e: &serde_json::Error) -> Self {
        Self::new(ErrorKind::Parse, e.to_string())
    }

    /// The project is not schedulable as given.
    pub(crate) fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidInput, message)
    }

    /// A task id the caller named is not in the project.
    pub(crate) fn unknown_task(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::UnknownTask, message)
    }

    /// A CPM pass could not complete a validated project.
    pub(crate) fn schedule(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Schedule, message)
    }

    /// The category, for Rust callers.
    pub fn error_kind(&self) -> ErrorKind {
        self.kind
    }

    /// The cycle chain, for Rust callers.
    pub fn cycle_chain(&self) -> Option<&[String]> {
        self.cycle.as_deref()
    }

    /// The message, for Rust callers.
    pub fn message_str(&self) -> &str {
        &self.message
    }
}

impl From<GraphBuildError> for SchedulerError {
    fn from(e: GraphBuildError) -> Self {
        let message = e.to_string();
        match e {
            GraphBuildError::Cyclic(c) => SchedulerError {
                kind: ErrorKind::Cycle,
                message,
                cycle: Some(c.cycle),
            },
            GraphBuildError::UnknownDependencyTask { .. } => Self::invalid_input(message),
        }
    }
}

impl std::fmt::Display for SchedulerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SchedulerError {}
