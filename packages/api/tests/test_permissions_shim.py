"""The trueppm_api.permissions shim must keep re-exporting the access permissions.

trueppm-enterprise imports these names from ``trueppm_api.permissions``; if the
shim drifts from the canonical ``trueppm_api.apps.access.permissions`` module,
enterprise breaks at import time.
"""

import trueppm_api.permissions as shim
from trueppm_api.apps.access import permissions as canonical


def test_shim_reexports_every_declared_name() -> None:
    for name in shim.__all__:
        assert getattr(shim, name) is getattr(canonical, name)


def test_shim_all_matches_import_list() -> None:
    expected = {
        "IsProjectAdmin",
        "IsProjectMember",
        "IsProjectMemberWrite",
        "IsProjectOwner",
        "IsProjectScheduler",
        "ProjectScopedViewSet",
    }
    assert set(shim.__all__) == expected
