"""Test helper: a bundled fixture as the generic import path is allowed to see it (#3603).

Bundled fixtures carry ``program.agent_actions`` and ``projects[].share_links``, which
only ``load_sample`` may honor. A test that feeds a fixture through ``import_seed``
without ``is_sample`` is exercising the generic path, so it strips them first — the
same edit a user makes to import a downloaded sample file.
"""

from __future__ import annotations

import copy
from typing import Any


def without_sample_only_sections(doc: dict[str, Any]) -> dict[str, Any]:
    stripped = copy.deepcopy(doc)
    stripped.get("program", {}).pop("agent_actions", None)
    for project in stripped.get("projects", []):
        project.pop("share_links", None)
    return stripped
