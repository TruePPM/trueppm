#!/usr/bin/env python3
"""gen-scheduler-conformance-report.py -- the scheduler's verification story, as a page (#4685).

An external assessment of 0.4.0 rated "independent verification" 7.5/10 and asked for a
scheduler-only conformance and benchmark report. The oracles, fuzzers and parity suites it
asked for already exist under ``packages/scheduler/tests/``; nothing published them. This
generates the page from the repo and from CI artifacts rather than from prose. The refusal
list, budgets, corpora and mutation scope are read from the tree; the coverage matrix cells
are hand-declared (see below) and only checked for the existence of the tests they cite.

Two parts, with different lifetimes:

  STATIC   deterministic facts read from the tree: the oracle coverage matrix, the refusal
           list (verbatim from ``test_cpm_oracle.py``'s docstring), Hypothesis budgets, the
           committed corpora, and the mutation scope. Committed into
           ``architecture/scheduler-conformance.md`` between the ``generated:`` markers;
           ``--check`` fails when the committed block no longer matches the tree, so the page
           cannot rot, and ``--write`` regenerates it.
  RELEASE  numbers that exist only after a run: engine version / git sha / date, mutation
           score, benchmark timings, Python<->Rust parity result. ``--release OUT`` writes
           them (plus the static part) to a file from the artifact paths given; with
           ``--strict`` ANY missing input is an error and nothing is written, because a
           partial report is worse than none.

THE MATRIX IS DECLARED, NOT DERIVED. A cell's status is a human claim about what a generator
draws, and no static read of a Hypothesis strategy can recover that. What the script does
enforce is that every test a cell cites still exists (AST), so deleting an oracle property
turns the page's claim into a failure instead of a lie. A reviewer still has to check the
cell values against the generators when they change -- the cites bound the claim, they do
not prove it.

Usage:
  python3 scripts/gen-scheduler-conformance-report.py --check | --write | --self-test
  python3 scripts/gen-scheduler-conformance-report.py --release OUT --strict \\
      --benchmark packages/scheduler/benchmark.json --mutation mutants/mutmut-cicd-stats.json \\
      --parity-result wasm-conformance.txt --sha <git sha>
"""

from __future__ import annotations

import argparse
import ast
import datetime as dt
import json
import re
import sys
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCHED = "packages/scheduler"
TESTS = f"{SCHED}/tests"
ORACLE_FILE = f"{TESTS}/test_cpm_oracle.py"
PAGE = "packages/website/src/content/docs/architecture/scheduler-conformance.md"
CORPUS = "packages/wasm-scheduler/fixtures/oracle/corpus.json"
BEGIN, END = "<!-- generated:begin -->", "<!-- generated:end -->"

LINKS = ("FS", "SS", "SF", "FF")
STATES = ("live", "complete, no actuals", "complete, with actuals")
SCOPES = ("project calendar", "per-task calendars")

REF, PAR, NOT = "reference-checked", "parity-only", "not generated"

# (link, state, scope) -> (status, cited tests). Anything absent is NOT generated.
# Verified by hand against ``progress_projects(modeled=True)``: ``_on_one_calendar`` rewrites an
# FF/SF link to FS/SS only when its two tasks sit on DIFFERENT calendars (a task with none
# counts as its own value), so an FF/SF link between two tasks on the same per-task calendar,
# or both on the project calendar, is still drawn and reference-checked in every state.
# Cross-calendar FF/SF is refused by the reference (#4639) and so is never generated. A
# completed milestone with recorded actuals is refused too: the generator drops its actuals.
_NET = ("test_python_engine_matches_reference_on_networks_of_work",)
_PROG = ("test_python_engine_matches_reference_with_progress",)
MATRIX: dict[tuple[str, str, str], tuple[str, tuple[str, ...]]] = {}
for _l in LINKS:
    MATRIX[(_l, STATES[0], SCOPES[0])] = (REF, _NET)
    MATRIX[(_l, STATES[1], SCOPES[0])] = (REF, _PROG)
    MATRIX[(_l, STATES[2], SCOPES[0])] = (REF, _PROG)
    for _s in STATES:
        MATRIX[(_l, _s, SCOPES[1])] = (REF, _PROG)

# Footnote markers appended to a cell's status.
_X_CAL, _X_MS = "\u2020", "\u2021"


def _marks(link: str, state: str, scope: str) -> str:
    out = ""
    if scope == SCOPES[1] and link in ("SF", "FF"):
        out += _X_CAL
    if state == STATES[2]:
        out += _X_MS
    return out


CITED = sorted({t for _, ts in MATRIX.values() for t in ts})


def read(rel: str) -> str:
    return (REPO / rel).read_text(encoding="utf-8")


def test_names(rel: str) -> set[str]:
    return {
        n.name for n in ast.walk(ast.parse(read(rel))) if isinstance(n, ast.FunctionDef)
    }


def given_counts() -> dict[str, int]:
    out: dict[str, int] = {}
    for p in sorted((REPO / TESTS).glob("test_*.py")):
        tree = ast.parse(p.read_text(encoding="utf-8"))
        n = sum(
            1
            for f in ast.walk(tree)
            if isinstance(f, ast.FunctionDef)
            and any(
                (isinstance(d, ast.Call) and getattr(d.func, "id", "") == "given")
                or (isinstance(d, ast.Name) and d.id == "given")
                for d in f.decorator_list
            )
        )
        if n:
            out[p.name] = n
    return out


def refusal_text() -> list[str]:
    """The oracle module's own bullets on what it does NOT generate, verbatim.

    Two bullets of the module docstring carry the list: what the reference comparison
    generates (and the shapes it refuses), and the summary-task limits. Markdown has no
    use for reST's double backticks, so those become single; the words are untouched.
    """
    doc = ast.get_docstring(ast.parse(read(ORACLE_FILE))) or ""
    bullets = re.split(r"\n(?=\* )", doc)
    keep = [
        b
        for b in bullets
        if b.startswith(("* Generated for the reference comparison", "* Summary tasks"))
    ]
    if len(keep) != 2:
        raise SystemExit(
            f"{ORACLE_FILE}: expected the 'Generated for the reference comparison' and "
            "'Summary tasks' bullets in the module docstring; the refusal list moved."
        )
    out = []
    for b in keep:
        text = " ".join(b.split())[2:]
        out.append(text.replace("``", "`").split(" The perturbation oracle")[0])
    return out


def budgets() -> dict[str, str]:
    conf = read(f"{TESTS}/conftest.py")
    gate = re.search(r'register_profile\("gate",\s*max_examples=(\d+)', conf)
    deep = re.search(r'FUZZ_MAX_EXAMPLES",\s*"(\d+)"', conf)
    ci = read(".gitlab-ci.yml")
    block = ci[ci.index("\nscheduler:fuzz-deep:") :]
    ci_deep = re.search(r'FUZZ_MAX_EXAMPLES:\s*"(\d+)"', block)
    if not (gate and deep and ci_deep):
        raise SystemExit(
            "cannot read the Hypothesis budgets (conftest.py / scheduler:fuzz-deep)"
        )
    return {
        "gate": gate.group(1),
        "deep-default": deep.group(1),
        "fuzz-deep": ci_deep.group(1),
    }


def corpora() -> dict[str, int]:
    c = json.loads(read(CORPUS))
    ms = REPO / TESTS / "fixtures" / "msproject"
    stab = REPO / TESTS / "fixtures" / "stability"
    return {
        "rust-parity-cases": len(c["cases"]),
        "msproject-fixtures": len(list(ms.glob("*.json")))
        + len(list(ms.glob("*.mpp"))),
        "stability-corpora": len([d for d in stab.iterdir() if d.is_dir()]),
    }


def mutation_scope() -> list[str]:
    cfg = tomllib.loads(read(f"{SCHED}/pyproject.toml"))["tool"]["mutmut"]
    return [re.sub(r"^\*/", "", m) for m in cfg["only_mutate"]]


def static_block() -> str:
    names = test_names(ORACLE_FILE)
    missing = [t for t in CITED if t not in names]
    if missing:
        raise SystemExit(
            f"matrix cites tests that no longer exist in {ORACLE_FILE}: {missing}. "
            "Update MATRIX in scripts/gen-scheduler-conformance-report.py."
        )
    lines = ["### Oracle coverage matrix", ""]
    head = ["Link"] + [f"{s} / {c}" for s in STATES for c in SCOPES]
    lines += ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for link in LINKS:
        row = [link]
        for s in STATES:
            for c in SCOPES:
                row.append(MATRIX.get((link, s, c), (NOT, ()))[0] + _marks(link, s, c))
        lines.append("| " + " | ".join(row) + " |")
    lines += [
        "",
        f"*{REF}*: the Python engine is compared date-for-date with an independent "
        f"reference implementation (`tests/oracle/reference_cpm.py`). *{PAR}*: no reference "
        "comparison, but a property over the engine's own output (the slip oracle) or a "
        f"Python/Rust comparison covers it. *{NOT}*: no generator draws that shape. "
        "Cell values are declared by hand in the generator and reviewed against the "
        "oracle's strategies; the build checks only that each cited property still exists: "
        + ", ".join(f"`{t}`" for t in CITED)
        + ".",
        "",
        f"{_X_CAL} On per-task calendars an FF/SF link is drawn only between two tasks on the "
        "same calendar (or two with none). An FF/SF link across two different calendars is "
        "refused by the reference (#4639), so it is rewritten to FS/SS and not generated.",
        "",
        f"{_X_MS} A completed milestone with recorded actuals is refused by the reference; the "
        "generator drops its actuals, so that shape is not generated.",
        "",
        "**What the reference refuses, verbatim from the oracle's own documentation:**",
        "",
    ]
    lines += [f"> {p}\n>" for p in refusal_text()]
    lines[-1] = lines[-1].rstrip(">").rstrip()
    b, cp = budgets(), corpora()
    given = given_counts()
    lines += [
        "",
        "### Hypothesis budgets",
        "",
        "| Profile | Examples per property |",
        "|---|---|",
        f"| `gate` (every pipeline, derandomized) | {b['gate']} |",
        f"| `scheduler:fuzz-deep` (nightly, randomized) | {int(b['fuzz-deep']):,} |",
        "",
        f"{sum(given.values())} Hypothesis properties across {len(given)} test files: "
        + ", ".join(
            f"`{f}` ({n})" for f, n in sorted(given.items(), key=lambda kv: -kv[1])[:8]
        )
        + ".",
        "",
        "### Committed corpora",
        "",
        f"- **Python/Rust parity corpus**: {cp['rust-parity-cases']} cases generated by the "
        "reference, asserted against the Rust engine under `wasm:test`.",
        f"- **MS Project known-answer fixtures**: {cp['msproject-fixtures']} files.",
        f"- **Cross-version result-stability corpora**: {cp['stability-corpora']} frozen "
        "versions.",
        "",
        "### Mutation testing scope",
        "",
        "Mutated modules: "
        + ", ".join(f"`{m}`" for m in mutation_scope())
        + ". "
        + (
            "`engine.py` is **not** in scope: its mutants are not scored."
            if "engine.py" not in mutation_scope()
            else "`engine.py` is in scope."
        ),
    ]
    return "\n".join(lines)


def splice(page: str, block: str) -> str:
    if BEGIN not in page or END not in page:
        raise SystemExit(f"{PAGE} lacks the {BEGIN} / {END} markers")
    head, rest = page.split(BEGIN, 1)
    _, tail = rest.split(END, 1)
    return f"{head}{BEGIN}\n\n{block}\n\n{END}{tail}"


def release_report(
    benchmark: Path | None,
    mutation: Path | None,
    parity: Path | None,
    sha: str | None,
    strict: bool,
) -> str:
    missing = [
        n
        for n, v in (
            ("--benchmark", benchmark),
            ("--mutation", mutation),
            ("--parity-result", parity),
            ("--sha", sha),
        )
        if not v or (isinstance(v, Path) and not v.is_file())
    ]
    if missing and strict:
        raise SystemExit(
            f"missing input(s): {', '.join(missing)} -- refusing to publish a partial report"
        )
    version = tomllib.loads(read(f"{SCHED}/pyproject.toml"))["project"]["version"]
    out = [
        f"## trueppm-scheduler {version} conformance report",
        "",
        f"- Engine version: {version}",
        f"- Git sha: {sha or 'not recorded'}",
        f"- Generated: {dt.datetime.now(dt.UTC):%Y-%m-%d}",
        "",
        "### Mutation score",
        "",
    ]
    if mutation and mutation.is_file():
        s = json.loads(mutation.read_text())
        killed, survived = int(s.get("killed", 0)), int(s.get("survived", 0))
        total = killed + survived + int(s.get("timeout", 0))
        out.append(
            f"{killed} killed, {survived} survived ({killed / total:.1%} of scoreable mutants) "
            f"over {', '.join(mutation_scope())}."
            if total
            else "no scoreable mutants."
        )
    else:
        out.append("not available in this build.")
    out += ["", "### Benchmarks", ""]
    if benchmark and benchmark.is_file():
        data = json.loads(benchmark.read_text())
        mi = data.get("machine_info", {})
        out += [
            f"Host: {mi.get('cpu', {}).get('brand_raw', 'unknown')}; Python "
            f"{mi.get('python_version', '?')}.",
            "",
            "| Benchmark | Mean (ms) | Median (ms) | Rounds |",
            "|---|---|---|---|",
        ]
        for b in sorted(data["benchmarks"], key=lambda x: x["name"]):
            st = b["stats"]
            out.append(
                f"| `{b['name']}` | {st['mean'] * 1e3:.2f} | {st['median'] * 1e3:.2f} | {st['rounds']} |"
            )
    else:
        out.append("not available in this build.")
    out += ["", "### Python/Rust parity", ""]
    out.append(
        parity.read_text().strip()
        if parity and parity.is_file()
        else "not available in this build."
    )
    return "\n".join(out) + "\n\n" + static_block() + "\n"


def self_test() -> int:
    ok = True

    def check(cond: bool, msg: str) -> None:
        nonlocal ok
        if not cond:
            print(f"SELF-TEST FAIL: {msg}")
            ok = False

    block = static_block()
    check(
        "reference-checked" in block and "not generated" in block,
        "matrix lacks statuses",
    )
    check(
        block.count("| FS |") == 1 and block.count("| FF |") == 1, "matrix rows missing"
    )
    page = f"x\n{BEGIN}\nSTALE-CONTENT\n{END}\ny\n"
    new = splice(page, block)
    check(
        new.startswith("x\n") and new.endswith("\ny\n") and "STALE-CONTENT" not in new,
        "splice",
    )
    check(splice(new, block) == new, "splice is not idempotent")
    try:
        splice("no markers", block)
        check(False, "splice accepted a page without markers")
    except SystemExit:
        pass
    try:
        release_report(None, None, None, None, strict=True)
        check(False, "strict release accepted missing inputs")
    except SystemExit as e:
        check(
            "missing input" in str(e), "strict error does not name the missing inputs"
        )
    check(
        "not available in this build"
        in release_report(None, None, None, "abc", strict=False),
        "lenient",
    )
    global CITED
    keep = CITED
    CITED = [*keep, "test_that_does_not_exist"]
    try:
        static_block()
        check(False, "a cited test that no longer exists was accepted")
    except SystemExit:
        pass
    CITED = keep
    print("self-test: OK" if ok else "self-test: FAILED")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--release", type=Path)
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("--benchmark", type=Path)
    ap.add_argument("--mutation", type=Path)
    ap.add_argument("--parity-result", type=Path)
    ap.add_argument("--sha")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    if a.release:
        a.release.write_text(
            release_report(a.benchmark, a.mutation, a.parity_result, a.sha, a.strict)
        )
        return 0
    page = read(PAGE)
    want = splice(page, static_block())
    if a.write:
        (REPO / PAGE).write_text(want, encoding="utf-8")
        return 0
    if want != page:
        print(
            f"{PAGE}: the generated block is stale against the tree. Run "
            "`python3 scripts/gen-scheduler-conformance-report.py --write`.",
            file=sys.stderr,
        )
        return 1
    print("scheduler-conformance page: up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
