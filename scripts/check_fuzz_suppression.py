#!/usr/bin/env python3
"""Assert the fuzz run really suppresses every Hypothesis health check (#2768).

A health check **aborts generation for an operation** rather than degrading it to
fewer examples. So a check that fires means that operation gets zero
`not_a_server_error` and zero `response_schema_conformance` coverage — while the
run still ends 602-of-603 green, which reads like a pass.

`POST /projects/{id}/tasks/bulk/` lived in that state. It was configured as
suppressed from #2364 onward and errored anyway, because the configured member
(`filter_too_much`) was not the member that fires: Schemathesis derives the
reported reason from the exception's *message text*, so an overrun that trips
`data_too_large` is reported as `filter_too_much` and the "obvious" suppression
does nothing. #2768 widens it to the full set.

This script exists because that failure was **silent for months**. Nothing
asserted that the configuration we ship actually resolves to the suppression we
believe it does — so a renamed key, a moved section, or an enum change in a new
`schemathesis>=4.0,<5.0` minor (the pin is not exact, and the installed version
moved 4.24.3 -> 4.25.1 across four nightlies) would quietly restore the old
behavior. The next occurrence should fail loudly, before the fuzz run, instead of
being discovered in an artifact nobody opens.

Run from `packages/api`, so `SchemathesisConfig.discover()` finds
`packages/api/schemathesis.toml` exactly as the fuzz job does.

Exit codes:
    0  every Hypothesis health check is suppressed
    1  one or more are not
    2  invocation error (schemathesis/hypothesis unavailable, config unreadable)

Usage:
    cd packages/api && python ../../scripts/check_fuzz_suppression.py
    python scripts/check_fuzz_suppression.py --self-test
"""

from __future__ import annotations

import sys


def _resolved_suppression() -> set[str]:
    """Health-check names the discovered config suppresses, as Hypothesis sees them.

    Expanded through ``as_hypothesis()`` rather than compared by the Schemathesis
    name, because the two vocabularies differ: Schemathesis accepts an ``all``
    alias that has no Hypothesis counterpart, and comparing the surface names
    would pass while suppressing nothing.
    """

    from schemathesis.config import SchemathesisConfig

    config = SchemathesisConfig.discover()
    return {
        member.name
        for item in config.suppress_health_check
        for member in item.as_hypothesis()
    }


def _all_hypothesis_checks() -> set[str]:
    from hypothesis import HealthCheck

    return {member.name for member in HealthCheck}


def check() -> int:
    try:
        resolved = _resolved_suppression()
        expected = _all_hypothesis_checks()
    except ImportError as exc:  # pragma: no cover - environment problem, not config
        print(f"ERROR: cannot import schemathesis/hypothesis: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # pragma: no cover - unreadable/invalid config
        print(
            f"ERROR: could not resolve the Schemathesis config: {exc}", file=sys.stderr
        )
        return 2

    missing = sorted(expected - resolved)
    if missing:
        print(
            "ERROR: the fuzz config does not suppress every Hypothesis health check.\n"
            f"       not suppressed: {', '.join(missing)}\n"
            f"       resolved:       {', '.join(sorted(resolved)) or '(none)'}\n"
            "\n"
            "A health check aborts generation for an operation rather than\n"
            "reducing it, so any operation that trips one gets ZERO coverage while\n"
            "the run still reports nearly all green (#2768).\n"
            "\n"
            "Fix: packages/api/schemathesis.toml must carry\n"
            '  suppress-health-check = ["all"]\n'
            "at the ROOT of the file. If a schemathesis upgrade moved or renamed\n"
            "that key, this is the upgrade breaking it — do not delete this check.",
            file=sys.stderr,
        )
        return 1

    print(
        f"OK: all {len(expected)} Hypothesis health checks suppressed for the fuzz run."
    )
    return 0


def self_test() -> int:
    """Assert the comparison itself is meaningful, without needing the real config.

    The failure this guards against is a check that cannot fail. Both directions
    are asserted: a full set passes, and a partial set — specifically the
    `filter_too_much`-only setting that was configured while the defect was live —
    must be reported as insufficient.
    """

    try:
        from hypothesis import HealthCheck
    except ImportError as exc:  # pragma: no cover
        print(f"ERROR: hypothesis unavailable: {exc}", file=sys.stderr)
        return 2

    every = {m.name for m in HealthCheck}

    if every - every:
        print("SELF-TEST FAILED: a full set reported missing members.", file=sys.stderr)
        return 1
    print("SELF-TEST OK: a full suppression set is accepted.")

    partial = {"filter_too_much"}
    missing = every - partial
    if not missing:
        print(
            "SELF-TEST FAILED: a filter_too_much-only set was accepted as complete "
            "— this is exactly the configuration that was live while the defect "
            "reproduced, so the check would be inert.",
            file=sys.stderr,
        )
        return 1
    print(
        f"SELF-TEST OK: filter_too_much-only correctly reported as missing {len(missing)}."
    )

    if "data_too_large" not in missing:
        print(
            "SELF-TEST FAILED: data_too_large is not in the expected set — the "
            "prime suspect for the #2768 overrun would go unchecked.",
            file=sys.stderr,
        )
        return 1
    print("SELF-TEST OK: data_too_large is covered by the expectation.")
    return 0


def main() -> int:
    if "--self-test" in sys.argv[1:]:
        return self_test()
    return check()


if __name__ == "__main__":
    sys.exit(main())
