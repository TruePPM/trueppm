"""Views for the profiles app (ADR-0129).

Exposes the caller's own app preferences at ``/auth/me/profile/``. There is no
``:id`` in the path and the view only ever touches ``request.user``'s row, so
there is no IDOR surface — a user can read and write only their own profile.
"""

from __future__ import annotations

from typing import cast

from django.contrib.auth.models import User
from drf_spectacular.utils import extend_schema
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.profiles.models import UserProfile
from trueppm_api.apps.profiles.serializers import UserProfileSerializer


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
