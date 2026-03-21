"""Top-level permission re-exports for backward compatibility.

All real permission classes and the ProjectScopedViewSet mixin live in
trueppm_api.apps.access.permissions. This module re-exports them so that
any code that imported from here continues to work without changes.
"""

from __future__ import annotations

from trueppm_api.apps.access.permissions import (  # noqa: F401
    IsProjectAdmin,
    IsProjectMember,
    IsProjectMemberWrite,
    IsProjectOwner,
    IsProjectScheduler,
    ProjectScopedViewSet,
)
