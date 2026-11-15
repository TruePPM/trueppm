"""The ``change`` discriminator on ``mention_group_changed`` is a frozen enum (#3793).

``FROZEN_WS_EVENT_TYPES`` pins the event name only. The five mutations ride a
secondary ``change`` string, which this test pins the same way: the closed set, every
call site, and the published docs must agree, so a value cannot land unannounced.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from trueppm_api.apps.access import views
from trueppm_api.apps.access.services import MENTION_GROUP_CHANGES

FROZEN = {"created", "updated", "deleted", "member_added", "member_removed"}
_DOCS = Path(__file__).resolve().parents[5] / "packages/website/src/content/docs/api/websockets.md"


def _literals(node: ast.expr) -> set[str]:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return {node.value}
    if isinstance(node, ast.IfExp):
        return _literals(node.body) | _literals(node.orelse)
    return set()


def test_enum_is_the_documented_five() -> None:
    assert MENTION_GROUP_CHANGES == FROZEN


def test_every_call_site_passes_a_frozen_value_and_all_are_used() -> None:
    tree = ast.parse(Path(views.__file__).read_text())
    used: set[str] = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "_broadcast"
            and len(node.args) == 3
        ):
            used |= _literals(node.args[2])
    assert used == FROZEN


@pytest.mark.parametrize(
    "name", ["UserDefinedMentionGroupViewSet", "ProgramUserDefinedMentionGroupViewSet"]
)
def test_unknown_change_is_refused(name: str) -> None:
    viewset = getattr(views, name)()
    with pytest.raises(ValueError):
        viewset._broadcast("p", "g", "renamed")


def test_websockets_docs_name_every_change_value() -> None:
    text = _DOCS.read_text()
    assert "mention_group_changed" in text
    for value in FROZEN:
        assert f"`{value}`" in text
