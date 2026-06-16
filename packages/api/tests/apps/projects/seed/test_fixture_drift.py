"""Guard the committed sample fixtures against silent drift from their builders.

The four bundled sample seeds under ``fixtures/seeds/`` are *generated* artifacts:
``scripts/seeds/build_atlas_seed.py`` and ``scripts/seeds/build_samples.py`` are
their single source of truth. The existing seed tests prove each committed
fixture still *loads*, schema-*validates*, and runs CPM/Monte Carlo — but none of
them prove the committed JSON still matches what its builder produces today. A
fixture hand-edited in place (or a builder changed without re-running it) passes
every other gate while quietly diverging from its generator, so the next
regenerate silently discards the manual edit.

This test closes that gap: regenerate each fixture in-process and assert it is
byte-identical to the committed file, using the exact serialization the build
scripts write (``json.dumps(..., indent=2, ensure_ascii=False) + "\n"``). The
builders are pure and deterministic (no clock, no randomness, anchor-relative
dates), so a mismatch always means real drift — re-run the build script and
commit the result.

Pure test: no database, no Django. It imports the builder functions directly
rather than shelling out, so a failure points at the specific fixture.
"""

from __future__ import annotations

import importlib.util
import json
from collections.abc import Callable
from pathlib import Path
from types import ModuleType

import pytest

# repo root: .../packages/api/tests/apps/projects/seed/this_file.py → parents[6]
_REPO_ROOT = Path(__file__).resolve().parents[6]
_SEEDS_SCRIPTS = _REPO_ROOT / "scripts" / "seeds"
_FIXTURES_DIR = (
    _REPO_ROOT
    / "packages"
    / "api"
    / "src"
    / "trueppm_api"
    / "apps"
    / "projects"
    / "fixtures"
    / "seeds"
)


def _load_script(name: str) -> ModuleType:
    """Import a build script by path (``scripts/seeds`` is not an importable package)."""
    path = _SEEDS_SCRIPTS / name
    spec = importlib.util.spec_from_file_location(f"_seed_builder_{path.stem}", path)
    assert spec is not None and spec.loader is not None, f"cannot load {path}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _builders() -> dict[str, Callable[[], dict]]:
    atlas = _load_script("build_atlas_seed.py")
    samples = _load_script("build_samples.py")
    # Mapping mirrors the writers in each script's main(): see build_atlas_seed.py
    # main() and build_samples.py main()'s `builders` dict — keep in sync if a
    # fifth sample is added.
    return {
        "atlas-platform-launch.json": atlas.build_atlas,
        "aurora-mobile-app.json": samples.build_aurora,
        "bayside-civic-center.json": samples.build_bayside,
        "helios-crm-replacement.json": samples.build_helios,
    }


def _serialize(seed: dict) -> str:
    """Replicate exactly how the build scripts write the fixture to disk."""
    return json.dumps(seed, indent=2, ensure_ascii=False) + "\n"


@pytest.mark.parametrize("filename", sorted(_builders()))
def test_committed_fixture_matches_builder(filename: str) -> None:
    """Each committed sample fixture must be byte-identical to its builder output.

    If this fails, the committed JSON has drifted from its generator. Re-run the
    owning build script and commit the regenerated fixture:

        python scripts/seeds/build_atlas_seed.py   # atlas-platform-launch.json
        python scripts/seeds/build_samples.py      # aurora / bayside / helios
    """
    builder = _builders()[filename]
    committed_path = _FIXTURES_DIR / filename
    assert committed_path.exists(), f"missing committed fixture: {committed_path}"

    generated = _serialize(builder())
    committed = committed_path.read_text(encoding="utf-8")

    if generated != committed:
        script = (
            "build_atlas_seed.py"
            if filename == "atlas-platform-launch.json"
            else "build_samples.py"
        )
        # Surface the first divergence so the failure is actionable in CI logs.
        gen_lines = generated.splitlines()
        com_lines = committed.splitlines()
        first_diff = next(
            (
                i
                for i in range(max(len(gen_lines), len(com_lines)))
                if i >= len(gen_lines) or i >= len(com_lines) or gen_lines[i] != com_lines[i]
            ),
            None,
        )
        context = ""
        if first_diff is not None:
            committed_line = com_lines[first_diff] if first_diff < len(com_lines) else "<EOF>"
            generated_line = gen_lines[first_diff] if first_diff < len(gen_lines) else "<EOF>"
            context = (
                f"\nFirst divergence at line {first_diff + 1}:"
                f"\n  committed:  {committed_line!r}"
                f"\n  generated:  {generated_line!r}"
            )
        pytest.fail(
            f"{filename} has drifted from its generator. "
            f"Re-run `python scripts/seeds/{script}` and commit the result."
            f"{context}"
        )


def test_every_committed_fixture_has_a_builder() -> None:
    """No orphan fixtures: every committed seed JSON must map to a builder.

    Catches the reverse drift — a fixture added to the directory by hand with no
    generator behind it, which would silently escape the byte-identity guard above.
    """
    committed = {p.name for p in _FIXTURES_DIR.glob("*.json")}
    known = set(_builders())
    orphans = committed - known
    assert not orphans, (
        f"committed fixture(s) with no builder in scripts/seeds/: {sorted(orphans)}. "
        "Add a builder (and register the sample) or remove the file."
    )
