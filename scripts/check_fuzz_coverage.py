#!/usr/bin/env python3
"""Fail the fuzz job when an operation was never actually fuzzed (#2768).

`api:fuzz` reports failures. It does not report **absence**. A Schemathesis
health check aborts generation for an operation rather than degrading it to fewer
examples, so a failing check means that operation gets **zero**
`not_a_server_error` and zero `response_schema_conformance` coverage — and the
run still ends with 580 of 581 operations green, which reads like a pass.

That is how `POST /projects/{id}/tasks/bulk/` went unfuzzed on the 2026-08-04 and
2026-08-05 nightlies: one `error` out of 581, on the one endpoint most in need of
the fuzzer (#2723 hardened it in the same window; #2757 found a real
schema-conformance defect in its response). Because `api:fuzz` is
`allow_failure: true` by design (#2212), the pipeline was green throughout.

Two assertions, because they catch different absences:

1. **No operation errored.** An `<error>` in the JUnit report is Schemathesis
   saying "I could not test this", which is the shape a health-check abort takes.
2. **Every documented operation appears.** An operation that never produced a
   `<testcase>` at all would satisfy (1) vacuously — it is not errored, it is
   missing. This compares the report against the operation count in the committed
   OpenAPI schema.

Exit codes:
    0  every documented operation was fuzzed
    1  an operation errored, or is absent from the report
    2  invocation error (report or schema unreadable)

Usage:
    python scripts/check_fuzz_coverage.py --report packages/api/junit-fuzz.xml \
                                          --schema docs/api/openapi.json
    python scripts/check_fuzz_coverage.py --self-test
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from xml.etree import ElementTree

# HTTP methods drf-spectacular emits as operation keys. `parameters` is a
# path-level sibling of the operations and must never be counted as one.
HTTP_METHODS = frozenset(
    {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
)


def operation_labels_from_schema(schema_path: Path) -> set[str]:
    """`{"POST /api/v1/projects/{id}/tasks/bulk/", ...}` from an OpenAPI document.

    Schemathesis labels a scenario ``"<METHOD> <path>"``, so the label set is
    derivable from the schema without running anything.
    """

    document = json.loads(schema_path.read_text())
    labels: set[str] = set()
    for path, operations in (document.get("paths") or {}).items():
        for method in operations:
            if method.lower() in HTTP_METHODS:
                labels.add(f"{method.upper()} {path}")
    return labels


def report_outcomes(report_path: Path) -> tuple[set[str], dict[str, str]]:
    """Return ``(labels_present, {label: error_text})`` from a Schemathesis JUnit report."""

    root = ElementTree.parse(report_path).getroot()
    present: set[str] = set()
    errored: dict[str, str] = {}
    for case in root.iter("testcase"):
        label = case.get("name") or ""
        present.add(label)
        error = case.find("error")
        if error is not None:
            first_line = (error.text or "").strip().splitlines()
            errored[label] = first_line[0] if first_line else "(no message)"
    return present, errored


def check(report_path: Path, schema_path: Path) -> int:
    if not report_path.is_file():
        print(f"ERROR: fuzz report not found: {report_path}", file=sys.stderr)
        print(
            "       The job did not get as far as writing one — read the trace.",
            file=sys.stderr,
        )
        return 2
    if not schema_path.is_file():
        print(f"ERROR: OpenAPI schema not found: {schema_path}", file=sys.stderr)
        return 2

    try:
        present, errored = report_outcomes(report_path)
    except ElementTree.ParseError as exc:
        print(f"ERROR: could not parse {report_path}: {exc}", file=sys.stderr)
        return 2

    documented = operation_labels_from_schema(schema_path)
    # Only report absences for operations the schema documents. Schemathesis can
    # emit labels the schema does not (a stateful-phase scenario, for one), and
    # flagging those would be noise rather than a coverage hole.
    absent = documented - present

    if not errored and not absent:
        print(f"OK: {len(present)} operation(s) fuzzed; none errored, none absent.")
        return 0

    if errored:
        print(
            f"ERROR: {len(errored)} operation(s) were NOT fuzzed — they errored:",
            file=sys.stderr,
        )
        for label, message in sorted(errored.items()):
            print(f"    {label}\n        {message}", file=sys.stderr)
        print(
            "\nAn error is not a failing check — it is Schemathesis reporting that it could\n"
            "not test the operation at all. That operation has zero not_a_server_error and\n"
            "zero response_schema_conformance coverage for this run.",
            file=sys.stderr,
        )
    if absent:
        print(
            f"\nERROR: {len(absent)} documented operation(s) produced no test case at all:",
            file=sys.stderr,
        )
        for label in sorted(absent):
            print(f"    {label}", file=sys.stderr)
    return 1


def _self_test() -> int:
    """Prove each branch fires. A guard nobody has watched fail is not a guard."""

    schema = {
        "paths": {
            "/api/v1/things/": {
                "get": {},
                "post": {},
                # A path-level `parameters` sibling must not be counted as an
                # operation — doing so would make the check permanently red.
                "parameters": [{"name": "q", "in": "query"}],
            }
        }
    }

    def report(cases: str) -> str:
        return f'<?xml version="1.0" encoding="utf-8"?>\n<testsuites><testsuite>{cases}</testsuite></testsuites>'

    both = '<testcase name="GET /api/v1/things/" /><testcase name="POST /api/v1/things/" />'
    cases = {
        "clean run": (report(both), 0),
        "an errored operation": (
            report(
                '<testcase name="GET /api/v1/things/" />'
                '<testcase name="POST /api/v1/things/">'
                "<error type='error'>Failed Health Check\nToo many filtered</error></testcase>"
            ),
            1,
        ),
        "an absent operation": (report('<testcase name="GET /api/v1/things/" />'), 1),
        "a malformed report": ("<testsuites", 2),
    }

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        schema_path = root / "openapi.json"
        schema_path.write_text(json.dumps(schema))

        for name, (body, expected) in cases.items():
            report_path = root / "junit.xml"
            report_path.write_text(body)
            actual = check(report_path, schema_path)
            if actual != expected:
                print(
                    f"SELF-TEST FAIL: {name} exited {actual}, expected {expected}",
                    file=sys.stderr,
                )
                return 1

        missing = check(root / "nope.xml", schema_path)
        if missing != 2:
            print(
                f"SELF-TEST FAIL: missing report exited {missing}, expected 2",
                file=sys.stderr,
            )
            return 1

    print("SELF-TEST OK: clean, errored, absent, malformed and missing all behave.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--report", type=Path, default=Path("packages/api/junit-fuzz.xml")
    )
    parser.add_argument("--schema", type=Path, default=Path("docs/api/openapi.json"))
    parser.add_argument(
        "--self-test", action="store_true", help="prove the check can fail"
    )
    args = parser.parse_args()

    if args.self_test:
        return _self_test()
    return check(args.report, args.schema)


if __name__ == "__main__":
    sys.exit(main())
