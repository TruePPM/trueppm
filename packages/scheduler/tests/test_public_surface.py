"""Public-surface contract tests for the trueppm-scheduler package (#1353, #1355).

These freeze the pip package's public API ahead of the 1.0 signature freeze: the
exported names (validator caps + the SchedulerError base), the exception
hierarchy, the consistent InvalidScheduleInput contract for degenerate input, the
enum value casing that PyPI consumers round-trip to disk, and the presence of
docstrings on the (de)serialization surface.
"""

from __future__ import annotations

from datetime import date, timedelta

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
