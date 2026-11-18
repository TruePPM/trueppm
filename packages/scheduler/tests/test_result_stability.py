"""Cross-version result-stability corpus (#4686, part of #3988).

Every other oracle checks the engine against a rule or against the other engine.
This one checks it against **its own previous release**: a frozen corpus of inputs
with the full ``ScheduleResult`` and seeded ``MonteCarloResult`` each produced,
stamped with the engine version that produced them, under
``fixtures/stability/<version>/corpus.json``.

Two checks:

* ``test_corpus_results_are_stable`` re-runs every committed stamp's inputs through
  the current engine and diffs field by field. Any drift fails, naming the case
  and the field.
* ``test_restamp_carries_a_changelog_fragment`` fails a branch that touches a
  stamp without adding a ``changelog.d/*.changed.md`` or ``*.fixed.md`` fragment
  that names an issue or ADR.

Re-stamp (only for a deliberate, documented change) with::

    REGEN_STABILITY=1 pytest tests/test_result_stability.py -k regenerate

Older stamps are kept, never rewritten, so release-over-release drift can be
reported. Pre-1.0 this is a disclosure guarantee, not a stability promise.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tomllib
from pathlib import Path
from typing import Any

import pytest

from trueppm_scheduler.engine import monte_carlo, schedule
from trueppm_scheduler.models import Project

PKG_DIR = Path(__file__).resolve().parent.parent
STABILITY_DIR = Path(__file__).resolve().parent / "fixtures" / "stability"
WASM_FIXTURES = PKG_DIR.parent / "wasm-scheduler" / "fixtures"
ORACLE_CORPUS = WASM_FIXTURES / "oracle" / "corpus.json"
CHANGELOG_DIR = PKG_DIR.parent.parent / "changelog.d"

MC_RUNS = 40
MC_SEED = 4686
# Every Nth Hypothesis-drawn oracle case: the oracle corpus is already a seeded,
# persisted draw, so reusing it keeps the seeds without a second generator.
ORACLE_STRIDE = 12

# The stability corpus is frozen data: the oracle corpus / fixtures it was drawn
# from may be regenerated later, which must not move the stamp. Inputs are
# therefore embedded in the stamp, and these sources are read only to (re)stamp.
REGEN = os.environ.get("REGEN_STABILITY") == "1"

# The stamp the working tree is held to. Older stamps are history: they record what
# an earlier release produced so N -> N+1 drift can be reported, and are never
# re-run for pass/fail (a release legitimately drifts from its predecessor; the
# per-MR check is what made each such drift carry a fragment). Bump this at each
# release cut, in the same commit that stamps the new directory.
CURRENT_STAMP = "0.5.0-dev"


def engine_version() -> str:
    """The version declared by ``pyproject.toml`` (the tree under test, not site-packages)."""
    with open(PKG_DIR / "pyproject.toml", "rb") as f:
        return str(tomllib.load(f)["project"]["version"])


def _run(project_dict: dict[str, Any]) -> dict[str, Any]:
    project = Project.from_dict(project_dict)
    out: dict[str, Any] = {"schedule": schedule(project).to_dict()}
    out["monte_carlo"] = monte_carlo(project, runs=MC_RUNS, seed=MC_SEED).to_dict()
    # Task order in a result is unspecified (ScheduleResult docstring); key by id.
    out["schedule"]["tasks"] = {t["id"]: t for t in out["schedule"]["tasks"]}
    return out


def _source_inputs() -> list[tuple[str, str, dict[str, Any]]]:
    cases: list[tuple[str, str, dict[str, Any]]] = []
    for p in sorted(WASM_FIXTURES.glob("*.json")):
        if p.name == "PROVENANCE.json":
            continue
        cases.append((f"fixture/{p.stem}", "wasm-conformance-fixture", json.loads(p.read_text())))
    for p in sorted((PKG_DIR / "tests" / "fixtures" / "msproject").glob("*.json")):
        data = json.loads(p.read_text())
        if isinstance(data, dict) and "tasks" in data and "start_date" in data:
            cases.append((f"msproject/{p.stem}", "msproject-parity-fixture", data))
    oracle = json.loads(ORACLE_CORPUS.read_text())
    named = [c for c in oracle["cases"] if c["name"].startswith("named_")]
    drawn = [c for c in oracle["cases"] if not c["name"].startswith("named_")][::ORACLE_STRIDE]
    for c in named + drawn:
        cases.append(
            (
                f"oracle/{c['name']}",
                f"hypothesis-oracle-corpus(seed={oracle['seed']},"
                f"progress_seed={oracle['progress_seed']},fraction_seed={oracle['fraction_seed']})",
                c["project"],
            )
        )
    return cases


def build_stamp() -> dict[str, Any]:
    """Run the current engine over the source inputs and return a stamp document."""
    cases = []
    for name, source, project in _source_inputs():
        try:
            cases.append({"name": name, "source": source, "project": project, **_run(project)})
        except Exception:  # inputs the engine rejects are not stability cases
            continue
    return {
        "engine_version": os.environ.get("STABILITY_STAMP_NAME", CURRENT_STAMP),
        "pyproject_version": engine_version(),
        "monte_carlo": {"runs": MC_RUNS, "seed": MC_SEED},
        "cases": cases,
    }


def _stamps() -> list[Path]:
    return sorted(STABILITY_DIR.glob("*/corpus.json"))


def _diff(path: str, expected: Any, actual: Any, out: list[str]) -> None:
    """Collect field-level differences, depth-first, capped by the caller."""
    if len(out) >= 20:
        return
    if isinstance(expected, dict) and isinstance(actual, dict):
        for k in sorted(set(expected) | set(actual)):
            if k not in expected or k not in actual:
                out.append(f"{path}.{k}: {'added' if k in actual else 'removed'}")
            else:
                _diff(f"{path}.{k}", expected[k], actual[k], out)
    elif isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            out.append(f"{path}: length {len(expected)} -> {len(actual)}")
        for i, (e, a) in enumerate(zip(expected, actual, strict=False)):
            _diff(f"{path}[{i}]", e, a, out)
    elif expected != actual:
        out.append(f"{path}: {expected!r} -> {actual!r}")


def test_corpus_is_present() -> None:
    """An empty or missing corpus would make every stability check vacuously green."""
    stamps = _stamps()
    assert stamps, f"no stability stamp under {STABILITY_DIR}"
    assert (STABILITY_DIR / "0.4.0" / "corpus.json").is_file()
    assert (STABILITY_DIR / CURRENT_STAMP / "corpus.json").is_file()
    for p in stamps:
        doc = json.loads(p.read_text())
        assert doc["engine_version"] == p.parent.name
        assert len(doc["cases"]) >= 100, f"{p} holds too few cases to mean anything"


@pytest.mark.skipif(REGEN, reason="regenerating")
def test_corpus_results_are_stable() -> None:
    """Re-run a frozen stamp's inputs; any field that moved is a release-visible change."""
    stamp = STABILITY_DIR / CURRENT_STAMP / "corpus.json"
    doc = json.loads(stamp.read_text())
    drift: list[str] = []
    for case in doc["cases"]:
        actual = _run(case["project"])
        for part in ("schedule", "monte_carlo"):
            diffs: list[str] = []
            _diff(f"{case['name']}.{part}", case[part], actual[part], diffs)
            drift.extend(diffs[:3])
        if len(drift) >= 20:
            break
    assert not drift, (
        f"Results changed against the {doc['engine_version']} stamp. If deliberate, add a "
        "changelog.d/<n>.changed.md (or .fixed.md) naming the issue/ADR and re-stamp: "
        "REGEN_STABILITY=1 pytest tests/test_result_stability.py -k regenerate\n"
        + "\n".join(drift[:20])
    )


@pytest.mark.skipif(REGEN, reason="regenerating")
def test_historical_stamps_are_kept_and_comparable() -> None:
    """Each kept stamp shares inputs with the current one, so release drift is reportable."""
    current = {
        c["name"]: c
        for c in json.loads((STABILITY_DIR / CURRENT_STAMP / "corpus.json").read_text())["cases"]
    }
    for p in _stamps():
        if p.parent.name == CURRENT_STAMP:
            continue
        old = json.loads(p.read_text())["cases"]
        shared = [c for c in old if c["name"] in current]
        assert shared, f"{p.parent.name} shares no cases with {CURRENT_STAMP}"
        assert all(c["project"] == current[c["name"]]["project"] for c in shared)


@pytest.mark.skipif(not REGEN, reason="set REGEN_STABILITY=1 to re-stamp")
def test_regenerate_current_stamp() -> None:
    """Write the stamp for the current engine version (re-stamp; needs a fragment)."""
    out = STABILITY_DIR / os.environ.get("STABILITY_STAMP_NAME", CURRENT_STAMP)
    out.mkdir(parents=True, exist_ok=True)
    stamp = build_stamp()
    # One compact case per line: small on disk, and a re-stamp diffs case by case.
    cases = ",\n".join(json.dumps(c, sort_keys=True, separators=(",", ":")) for c in stamp["cases"])
    head = json.dumps({k: v for k, v in stamp.items() if k != "cases"}, sort_keys=True)[:-1]
    (out / "corpus.json").write_text(f'{head}, "cases": [\n{cases}\n]}}\n')


_FRAGMENT = re.compile(r"(^|/)changelog\.d/[^/]+\.(changed|fixed)\.md$")
_REFERENCE = re.compile(r"#\d+|ADR-\d+", re.IGNORECASE)


def _git(*args: str) -> str | None:
    try:
        r = subprocess.run(
            ["git", *args], cwd=PKG_DIR, capture_output=True, text=True, timeout=60, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 else None


def _branch_changes() -> tuple[list[str], list[str]] | None:
    """(changed paths, added paths) of this branch vs its merge base with origin/main."""
    base = _git("merge-base", "origin/main", "HEAD")
    if base is None:
        return None
    status = _git("diff", "--name-status", "--no-renames", base.strip())
    untracked = _git("ls-files", "--others", "--exclude-standard", "--full-name")
    if status is None:
        return None
    changed: list[str] = []
    added: list[str] = []
    for line in status.splitlines():
        code, _, path = line.partition("\t")
        changed.append(path)
        if code == "A":
            added.append(path)
    for path in (untracked or "").splitlines():
        changed.append(path)
        added.append(path)
    return changed, added


def check_restamp_has_fragment(
    changed: list[str], added: list[str], read: Any = lambda p: Path(p).read_text()
) -> str | None:
    """Return a failure message if a stamp changed without an explaining fragment."""
    # A brand-new stamp is the release flow (a new version directory); only an
    # existing stamp being rewritten or deleted is a drift being re-blessed.
    touched = [p for p in changed if "tests/fixtures/stability/" in p and p not in added]
    if not touched:
        return None
    for p in added:
        if _FRAGMENT.search(p):
            try:
                if _REFERENCE.search(read(p)):
                    return None
            except OSError:
                continue
    return (
        f"stability stamp changed ({touched[0]}…) but no new changelog.d/*.changed.md or "
        "*.fixed.md fragment naming an issue (#N) or ADR (ADR-N) accompanies it (#4686)"
    )


def test_restamp_carries_a_changelog_fragment() -> None:
    """A changed stamp must ship with a fragment saying why dates moved."""
    changes = _branch_changes()
    if changes is None:
        pytest.skip("no origin/main merge base available (shallow clone or sdist)")
    root = PKG_DIR.parent.parent
    msg = check_restamp_has_fragment(*changes, read=lambda p: (root / p).read_text())
    assert msg is None, msg


class TestFragmentRule:
    """The rule itself, on synthetic change sets (the live check above is git-dependent)."""

    STAMP = "packages/scheduler/tests/fixtures/stability/0.4.0/corpus.json"
    FRAG = "changelog.d/1.changed.md"

    def test_untouched_stamp_needs_nothing(self) -> None:
        assert check_restamp_has_fragment(["README.md"], []) is None

    def test_a_new_version_stamp_needs_no_fragment(self) -> None:
        assert check_restamp_has_fragment([self.STAMP], [self.STAMP]) is None

    def test_touched_stamp_without_fragment_fails(self) -> None:
        assert check_restamp_has_fragment([self.STAMP], []) is not None

    def test_fragment_must_name_an_issue_or_adr(self) -> None:
        args = ([self.STAMP, self.FRAG], [self.FRAG])
        assert check_restamp_has_fragment(*args, read=lambda p: "- floats changed") is not None
        assert check_restamp_has_fragment(*args, read=lambda p: "- floats changed (#123)") is None

    def test_added_type_does_not_count(self) -> None:
        frag = "changelog.d/1.added.md"
        assert (
            check_restamp_has_fragment([self.STAMP, frag], [frag], read=lambda p: "#1") is not None
        )

    def test_fixed_fragment_counts(self) -> None:
        frag = "changelog.d/1.fixed.md"
        assert (
            check_restamp_has_fragment([self.STAMP, frag], [frag], read=lambda p: "ADR-9") is None
        )
