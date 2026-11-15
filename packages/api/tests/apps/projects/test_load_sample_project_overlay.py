"""``load_sample_project``'s demo landing overlay wrapper (#4050 Part B).

The overlay's own behavior is covered in ``seed/test_demo_landing_overlay.py``; this
file covers what the *command* does around it — gate it on the deployment mode and
the sample key, and turn a fixture mismatch into a ``CommandError`` so the seed Job
(and with it the Helm release) fails loudly.
"""

from __future__ import annotations

from io import StringIO
from typing import Any
from unittest import mock

import pytest
from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command

from trueppm_api.apps.projects.seed.demo_landing_overlay import DemoOverlayFixtureMismatch

pytestmark = pytest.mark.django_db

User = get_user_model()

_OVERLAY = (
    "trueppm_api.apps.projects.management.commands.load_sample_project.apply_demo_landing_overlay"
)


@pytest.fixture(autouse=True)
def _owner() -> Any:
    return User.objects.create_user(username="overlay-cmd-owner", email="oc@example.com")


def _run(*args: str) -> str:
    out = StringIO()
    call_command("load_sample_project", "--owner", "overlay-cmd-owner", *args, stdout=out)
    return out.getvalue()


def test_a_fixture_mismatch_becomes_a_command_error(settings: Any) -> None:
    settings.DEMO_READ_ONLY = True
    with (
        mock.patch(_OVERLAY, side_effect=DemoOverlayFixtureMismatch("no such task 'X'")),
        pytest.raises(CommandError, match="#4050 Part B") as err,
    ):
        _run()
    assert "no such task 'X'" in str(err.value)
    assert isinstance(err.value.__cause__, DemoOverlayFixtureMismatch)


def test_the_overlay_does_not_run_outside_a_read_only_demo(settings: Any) -> None:
    settings.DEMO_READ_ONLY = False
    with mock.patch(_OVERLAY) as overlay:
        _run()
    overlay.assert_not_called()


def test_a_non_default_sample_skips_the_overlay_and_says_so(settings: Any) -> None:
    settings.DEMO_READ_ONLY = True
    with mock.patch(_OVERLAY) as overlay:
        out = _run("--sample", "aurora-mobile-app")
    overlay.assert_not_called()
    assert "Demo landing overlay skipped" in out
    assert "aurora-mobile-app" in out
