"""Public-surface contract tests for the trueppm-scheduler package (#1353, #1355).

These freeze the pip package's public API ahead of the 1.0 signature freeze: the
exported names (validator caps + the SchedulerError base), the exception
hierarchy, the consistent InvalidScheduleInput contract for degenerate input, the
enum value casing that PyPI consumers round-trip to disk, and the presence of
docstrings on the (de)serialization surface.
"""

from __future__ import annotations

import dataclasses
import re
import tomllib
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest

import trueppm_scheduler as ts
from trueppm_scheduler import (
    DeliveryMode,
    DependencyType,
    InvalidScheduleInput,
    Project,
    SchedulerError,
    Task,
    monte_carlo,
    schedule,
)

_VALIDATOR_CAPS = (
    "MAX_DEPENDENCIES",
    "MAX_DURATION_DAYS",
    "MAX_LAG_DAYS",
    "MAX_CALENDAR_SCAN_DAYS",
    "MAX_PROJECT_SPAN_DAYS",
    "MAX_EXPANDED_EDGES",
    "MAX_CALENDAR_EXCEPTIONS",
    "MAX_LAG_DELTA_CELLS",
    "MAX_VELOCITY_SPRINTS",
    "MC_SENSITIVITY_CAP",
)


def _one_task_project() -> Project:
    return Project(
        id="p",
        name="P",
        start_date=date(2026, 1, 1),
        tasks=[Task(id="A", name="A", duration=timedelta(days=1))],
    )


def _empty_project() -> Project:
    return Project(id="p", name="P", start_date=date(2026, 1, 1), tasks=[])


class TestExportedNames:
    @pytest.mark.parametrize("name", _VALIDATOR_CAPS)
    def test_validator_caps_are_importable_from_package_root(self, name: str) -> None:
        # The caps exist precisely so downstream validators can enforce the same
        # bounds; the comment promising they're "exported" is now true (#1353).
        assert name in ts.__all__, f"{name} missing from __all__"
        assert isinstance(getattr(ts, name), int)

    def test_scheduler_error_is_exported(self) -> None:
        assert "SchedulerError" in ts.__all__
        assert ts.SchedulerError is SchedulerError


class TestExceptionHierarchy:
    def test_scheduler_error_subclasses_value_error(self) -> None:
        assert issubclass(SchedulerError, ValueError)

    @pytest.mark.parametrize(
        "exc",
        [
            ts.CyclicDependencyError,
            ts.SimulationCapExceeded,
            ts.InvalidScheduleInput,
            ts.UnknownTaskError,
        ],
    )
    def test_concrete_exceptions_subclass_scheduler_error(self, exc: type) -> None:
        assert issubclass(exc, SchedulerError)
        # Backward compatible: still a ValueError, so existing handlers keep working.
        assert issubclass(exc, ValueError)

    def test_every_exported_exception_subclasses_scheduler_error(self) -> None:
        """No exported exception may escape ``except SchedulerError`` (#2180).

        The whole point of the ``SchedulerError`` base is that one handler catches
        every scheduler-originated failure. Enumerate the public surface rather
        than a hand-maintained list so a newly exported exception (e.g. the next
        ``UnknownTaskError``, which shipped subclassing a bare ``ValueError``) is
        caught here instead of silently escaping the contract.
        """
        exported_exceptions = [
            obj
            for name in ts.__all__
            if isinstance(obj := getattr(ts, name), type) and issubclass(obj, BaseException)
        ]
        # SchedulerError itself is the base; every other exported exception is a
        # strict subclass of it.
        assert SchedulerError in exported_exceptions
        for exc in exported_exceptions:
            assert issubclass(exc, SchedulerError), (
                f"{exc.__name__} is exported but does not subclass SchedulerError; "
                "it would escape `except SchedulerError`."
            )


class TestDegenerateInputContract:
    """Empty-project / runs<1 raise the documented InvalidScheduleInput (#1353)."""

    def test_schedule_empty_project_raises_invalid_schedule_input(self) -> None:
        with pytest.raises(InvalidScheduleInput, match="at least one task"):
            schedule(_empty_project())

    def test_monte_carlo_empty_project_raises_invalid_schedule_input(self) -> None:
        with pytest.raises(InvalidScheduleInput, match="at least one task"):
            monte_carlo(_empty_project(), runs=10)

    def test_monte_carlo_runs_below_one_raises_invalid_schedule_input(self) -> None:
        with pytest.raises(InvalidScheduleInput, match="positive integer"):
            monte_carlo(_one_task_project(), runs=0)

    def test_degenerate_input_is_catchable_as_scheduler_error(self) -> None:
        # A consumer can now catch any scheduler-originated failure with one type.
        with pytest.raises(SchedulerError):
            schedule(_empty_project())


_EXPECTED_FIELD_ORDER: dict[str, list[str]] = {
    "Calendar": [
        "working_days",
        "exceptions",
        "hours_per_day",
        "timezone",
        "_exc_index",
        "_exc_src",
    ],
    "CycleCheck": ["cycle"],
    "DateRange": ["start", "end"],
    "Dependency": ["predecessor_id", "successor_id", "dep_type", "lag"],
    "Derivation": [
        "task_id",
        "task_name",
        "quantity",
        "value",
        "pass_",
        "is_critical",
        "binding",
        "contributions",
    ],
    "DerivationContribution": [
        "kind",
        "source_task_id",
        "source_task_name",
        "dep_type",
        "lag_days",
        "imposed_date",
        "calendar_days_added",
        "slack_days",
        "is_binding",
    ],
    "DrivingEdge": ["predecessor_id", "successor_id", "dep_type"],
    "MonteCarloResult": [
        "project_id",
        "runs",
        "p50",
        "p80",
        "p95",
        "distribution",
        "sensitivity",
    ],
    "Project": [
        "id",
        "name",
        "start_date",
        "tasks",
        "dependencies",
        "calendar",
        "velocity_samples",
        "sprint_length_days",
        "status_date",
        "calendars",
    ],
    "ScheduleResult": [
        "project_id",
        "project_start",
        "project_finish",
        "tasks",
        "critical_path",
        "driving_edges",
    ],
    "SummaryExpansion": ["tasks", "dependencies"],
    "Task": [
        "id",
        "name",
        "duration",
        "planned_start",
        "planned_finish",
        "early_start",
        "early_finish",
        "late_start",
        "late_finish",
        "total_float",
        "free_float",
        "is_critical",
        "percent_complete",
        "actual_start",
        "actual_finish",
        "optimistic_duration",
        "most_likely_duration",
        "pessimistic_duration",
        "delivery_mode",
        "story_points",
        "calendar_id",
        # Appended (#2836) rather than grouped with the other CPM-computed
        # dates, so 0.3.0a3's positional order is preserved exactly.
        "scheduled_start",
    ],
    "TaskSensitivity": ["task_id", "index"],
}


class TestDataclassFieldOrderContract:
    """Field order of every exported dataclass is a positional contract (#2836).

    ``Task`` and friends are plain, non-``kw_only`` dataclasses exported in
    ``__all__``, so their declaration order *is* the positional signature every
    PyPI consumer binds against. Nothing else catches a mid-sequence insertion:
    dataclasses do no runtime type validation, so a consumer passing the old
    positional order gets **no** ``TypeError`` — the arguments simply land in the
    wrong fields and propagate into float and criticality output as a confident,
    wrong answer. ``Task.scheduled_start`` was inserted between ``late_finish``
    and ``total_float`` and shifted the twelve fields after it; that is the bug
    this class exists to make impossible to repeat.

    **New fields append.** If one of these assertions fails because you added a
    field, move it to the end of the class and append its name to the list here.
    Do not simply paste the new order in: that would re-freeze a break.
    Reordering or removing a field is a major-version change and needs a
    ``### Changed`` entry in ``packages/scheduler/CHANGELOG.md``.

    Private, ``init=False`` bookkeeping fields (``Calendar._exc_index`` /
    ``_exc_src``) are pinned too — they consume no positional slot, but pinning
    the full ``dataclasses.fields()`` order keeps this a single, unambiguous
    statement of what the class declares.
    """

    def test_every_exported_dataclass_is_pinned_here(self) -> None:
        """A newly exported dataclass must be added to the map, not skipped.

        Without this, a new dataclass would join ``__all__`` with no order
        contract at all and the guard would silently stop covering it.
        """
        exported = {
            name
            for name in ts.__all__
            if dataclasses.is_dataclass(obj := getattr(ts, name)) and isinstance(obj, type)
        }
        assert exported == set(_EXPECTED_FIELD_ORDER), (
            "Exported dataclasses and the pinned field-order map disagree; "
            f"unpinned={sorted(exported - set(_EXPECTED_FIELD_ORDER))}, "
            f"stale={sorted(set(_EXPECTED_FIELD_ORDER) - exported)}"
        )

    @pytest.mark.parametrize("name", sorted(_EXPECTED_FIELD_ORDER))
    def test_field_order_matches_the_published_positional_contract(self, name: str) -> None:
        cls = getattr(ts, name)
        actual = [f.name for f in dataclasses.fields(cls)]
        assert actual == _EXPECTED_FIELD_ORDER[name], (
            f"{name} field order changed — this is a positional break for every "
            "consumer constructing it positionally, and dataclasses raise no "
            "TypeError to warn them. Append new fields at the end instead."
        )


class TestPositionalConstruction:
    """A positionally-constructed Task must schedule identically (#2836)."""

    def test_positional_and_keyword_task_agree_on_float(self) -> None:
        # The exact shape a 0.3.0a3 consumer writes: ten positional arguments,
        # the tenth being total_float. Under the mid-sequence insertion that
        # tenth argument bound to scheduled_start instead — no exception, just a
        # wrong total_float, free_float and is_critical out of schedule().
        positional = Task(
            "t1",
            "Build",
            timedelta(days=5),
            None,
            None,
            None,
            None,
            None,
            None,
            timedelta(days=2),
            timedelta(days=1),
            False,
            50.0,
        )
        keyword = Task(
            id="t1",
            name="Build",
            duration=timedelta(days=5),
            total_float=timedelta(days=2),
            free_float=timedelta(days=1),
            is_critical=False,
            percent_complete=50.0,
        )
        assert positional == keyword
        assert positional.total_float == timedelta(days=2)
        assert positional.free_float == timedelta(days=1)
        assert positional.percent_complete == 50.0
        # The inserted field must not have swallowed a positional slot.
        assert positional.scheduled_start is None

        def _floats(t: Task) -> tuple[timedelta, timedelta, bool]:
            result = schedule(Project(id="p", name="P", start_date=date(2026, 1, 5), tasks=[t]))
            out = result.tasks[0]
            return out.total_float, out.free_float, out.is_critical

        assert _floats(positional) == _floats(keyword)


class TestEnumCasingContract:
    """Frozen value casing — round-tripped to disk by PyPI consumers (#1355)."""

    def test_dependency_type_values_are_uppercase_acronyms(self) -> None:
        assert {m.value for m in DependencyType} == {"FS", "FF", "SS", "SF"}
        for m in DependencyType:
            assert m.value == m.name  # acronym: value == (uppercase) name

    def test_delivery_mode_values_are_lowercase_words(self) -> None:
        assert {m.value for m in DeliveryMode} == {"waterfall", "scrum"}
        for m in DeliveryMode:
            assert m.value == m.name.lower()


class TestSerializationDocstrings:
    """The PyPI (de)serialization contract is documented (#1353)."""

    @pytest.mark.parametrize(
        ("cls", "method"),
        [
            (ts.DateRange, "to_dict"),
            (ts.DateRange, "from_dict"),
            (ts.Task, "to_dict"),
            (ts.Task, "from_dict"),
            (ts.Dependency, "to_dict"),
            (ts.Dependency, "from_dict"),
            (ts.Calendar, "to_dict"),
            (ts.Calendar, "from_dict"),
            (ts.Project, "to_dict"),
            (ts.Project, "from_dict"),
            (ts.Project, "to_json"),
            (ts.Project, "from_json"),
        ],
    )
    def test_serialization_methods_have_docstrings(self, cls: type, method: str) -> None:
        doc = getattr(cls, method).__doc__
        assert doc is not None and doc.strip(), f"{cls.__name__}.{method} lacks a docstring"

    def test_every_public_method_on_every_exported_class_has_a_docstring(self) -> None:
        """Discovery, not a list — the list above is why eight of them were missed.

        CLAUDE.md requires a docstring on every exported function/class in
        ``packages/scheduler`` because it is a pip package, and the parametrized
        list above enforced that for the twelve (de)serialization methods someone
        thought to enumerate. Meanwhile ``to_dict()`` on ``ScheduleResult``,
        ``MonteCarloResult``, ``TaskSensitivity``, ``DrivingEdge``, ``CycleCheck``,
        ``Derivation`` and ``DerivationContribution`` — and ``Calendar``'s
        ``is_working_day()``, the predicate the whole engine rests on — shipped
        undocumented, because a hand-maintained list only covers what was already
        remembered.

        This walks ``__all__`` instead, so a new export is covered the moment it is
        added rather than the moment someone adds it here too (#2837).
        """
        undocumented: list[str] = []
        for name in ts.__all__:
            obj = getattr(ts, name)
            if isinstance(obj, type):
                if not (obj.__doc__ or "").strip():
                    undocumented.append(f"{name} (class)")
                for attr, member in vars(obj).items():
                    if attr.startswith("_") or not callable(member):
                        continue
                    if not (getattr(member, "__doc__", None) or "").strip():
                        undocumented.append(f"{name}.{attr}()")
            elif callable(obj) and not (obj.__doc__ or "").strip():
                undocumented.append(f"{name}()")

        assert not undocumented, (
            "These exported names have no docstring, and this package's README "
            "defines the public API as exactly the __all__ surface:\n  "
            + "\n  ".join(sorted(undocumented))
        )


class TestReleaseMetadataConsistency:
    """The release-notes step is manual and had no gate at all (#2837).

    Three surfaces describe the same release — ``pyproject.toml``'s ``version`` and
    trove classifier, the top ``CHANGELOG.md`` heading, and the README's stated
    maturity — and nothing compared them. All three had drifted at once: the
    version said ``0.4.0b1`` while every 0.4 change still sat under
    ``## [Unreleased]``, and the README claimed ``3 - Alpha`` while the classifier
    PyPI actually renders said ``4 - Beta``.

    The wheel force-includes ``CHANGELOG.md``, and the README *is* the PyPI
    long-description, so both are consumer-facing artifacts rather than internal
    notes. That is what makes a mismatch a shipped defect.
    """

    @staticmethod
    def _pkg_root() -> Path:
        return Path(__file__).resolve().parents[1]

    @classmethod
    def _pyproject(cls) -> dict[str, Any]:
        return tomllib.loads((cls._pkg_root() / "pyproject.toml").read_text())

    def test_the_declared_version_has_a_changelog_section(self) -> None:
        version = self._pyproject()["project"]["version"]
        changelog = (self._pkg_root() / "CHANGELOG.md").read_text()
        assert f"## [{version}]" in changelog, (
            f"pyproject declares version {version} but CHANGELOG.md has no "
            f"'## [{version}]' section. The wheel force-includes the changelog, so "
            f"it is the only migration note an upgrader gets — cut the section "
            f"before bumping the version, not after."
        )

    def test_the_changelog_top_section_is_unreleased_or_the_declared_version(self) -> None:
        """The newest version heading must be the one being shipped.

        Catches the inverse drift: a section cut for a version that was then bumped
        past, leaving the changelog describing a release that never existed.
        """
        version = self._pyproject()["project"]["version"]
        changelog = (self._pkg_root() / "CHANGELOG.md").read_text()
        headings = re.findall(r"^## \[([^\]]+)\]", changelog, flags=re.MULTILINE)
        assert headings, "CHANGELOG.md has no version headings"
        newest = next(h for h in headings if h != "Unreleased")
        assert newest == version, (
            f"The newest CHANGELOG version section is [{newest}] but pyproject declares {version}."
        )

    def test_the_readme_maturity_matches_the_trove_classifier(self) -> None:
        """The README is the long-description PyPI renders next to the classifier."""
        classifiers = self._pyproject()["project"]["classifiers"]
        declared = next(c for c in classifiers if c.startswith("Development Status ::"))
        stage = declared.split("::")[-1].strip()  # e.g. "4 - Beta"
        readme = (self._pkg_root() / "README.md").read_text()

        assert f"`Development Status :: {stage}`" in readme, (
            f"pyproject declares '{declared}' but README.md does not state it. PyPI "
            f"renders the README beside the classifier badge, so a mismatch puts the "
            f"two maturity claims side by side on the project page."
        )
        other_stages = {"3 - Alpha", "4 - Beta", "5 - Production/Stable"} - {stage}
        for wrong in other_stages:
            assert f"Development Status :: {wrong}" not in readme, (
                f"README.md still claims 'Development Status :: {wrong}' while the "
                f"classifier says '{stage}'."
            )

    def test_the_readmes_pinned_version_example_is_the_declared_version(self) -> None:
        """``trueppm-scheduler==X`` in the README must be installable and current."""
        version = self._pyproject()["project"]["version"]
        readme = (self._pkg_root() / "README.md").read_text()
        pins = set(re.findall(r"trueppm-scheduler==([0-9][^\s`\)]*)", readme))
        assert pins, "README.md shows no `trueppm-scheduler==<version>` pin example"
        assert pins == {version}, (
            f"README.md pins {sorted(pins)} but pyproject declares {version} — the "
            f"copy-paste install line would give the reader the wrong release."
        )
