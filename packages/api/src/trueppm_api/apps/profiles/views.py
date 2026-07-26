"""Views for the profiles app (ADR-0129).

Exposes the caller's own app preferences at ``/auth/me/profile/``. There is no
``:id`` in the path and the view only ever touches ``request.user``'s row, so
there is no IDOR surface — a user can read and write only their own profile.
"""

from __future__ import annotations

from typing import Any, cast

from django.contrib.auth.models import User
from drf_spectacular.utils import extend_schema
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.profiles.models import UserPin, UserProfile
from trueppm_api.apps.profiles.serializers import PinnedItemSerializer, UserProfileSerializer


class MyProfileView(APIView):
    """GET/PATCH ``/api/v1/auth/me/profile/`` — the caller's own app preferences.

    The profile row is created lazily, so a user who has never set a preference
    reads the default (``default_landing="auto"``) without a backfill.
    """

    permission_classes = [IsAuthenticated]

    def _get_profile(self, request: Request) -> UserProfile:
        # IsAuthenticated guarantees a concrete user here; narrow off the
        # User | AnonymousUser union for the FK lookup.
        user = cast(User, request.user)
        profile, _ = UserProfile.objects.get_or_create(user=user)
        return profile

    @extend_schema(responses={200: UserProfileSerializer})
    def get(self, request: Request) -> Response:
        return Response(UserProfileSerializer(self._get_profile(request)).data)

    @extend_schema(request=UserProfileSerializer, responses={200: UserProfileSerializer})
    def patch(self, request: Request) -> Response:
        serializer = UserProfileSerializer(
            self._get_profile(request), data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)


class MyPinnedView(APIView):
    """GET ``/api/v1/auth/me/pinned/`` — the caller's own pinned items (#2390).

    Returns projects and programs in one merged, most-recently-pinned-first list
    so the rail can render its single flat jump group without two round-trips.

    **Self-scoped by construction.** The queryset filters on ``request.user`` and
    takes no user parameter, so there is no shape of this request that returns
    another person's pins (ADR-0627 §D5). ``pinned_at`` is exposed here and
    *only* here — never on a shared Project/Program payload — because a recency
    timestamp visible to a teammate is precisely what would let a pin be read as
    an engagement metric.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="List the requesting user's pinned projects and programs",
        description=(
            "Returns **only the requesting user's own** pins, most recently "
            "pinned first. There is no parameter that selects another user, and "
            "no endpoint anywhere reports who pinned an item or how many users "
            "pinned it. A pin is a private wayfinding preference."
        ),
        responses={200: PinnedItemSerializer(many=True)},
    )
    def get(self, request: Request) -> Response:
        user = cast(User, request.user)
        pins = (
            UserPin.objects.filter(user=user)
            .select_related("project", "project__program", "program")
            .order_by("-pinned_at")
        )
        items = [item for pin in pins if (item := _pinned_item(pin)) is not None]
        return Response(PinnedItemSerializer(items, many=True).data)


def _pinned_item(pin: UserPin) -> dict[str, Any] | None:
    """Flatten one UserPin row into the merged wire shape.

    Projects carry their parent program's id/name so the rail can render the
    "Program › Project" breadcrumb without a second lookup; programs leave both
    null.

    Returns ``None`` for a row with neither target. The XOR CheckConstraint makes
    that unreachable, but the constraint is invisible to the type checker and a
    silently skipped row is a better failure than a 500 on the whole rail.
    """
    project = pin.project
    if project is not None:
        program = project.program
        return {
            "kind": "project",
            "id": str(project.pk),
            "name": project.name,
            "code": None,
            "program_id": str(program.pk) if program is not None else None,
            "program_name": program.name if program is not None else None,
            "pinned_at": pin.pinned_at,
        }
    owning_program = pin.program
    if owning_program is None:
        return None
    return {
        "kind": "program",
        "id": str(owning_program.pk),
        "name": owning_program.name,
        "code": owning_program.code,
        "program_id": None,
        "program_name": None,
        "pinned_at": pin.pinned_at,
    }
