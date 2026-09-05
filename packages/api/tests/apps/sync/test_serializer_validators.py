"""Direct-call coverage for the sync pull serializers' ``validate_timezone`` hooks.

Sync serves these serializers in the pull direction only (``upload.WRITABLE_COLLECTIONS``
names ``tasks`` alone), so no endpoint ever runs the validators — they exist so a push
path added later inherits the write-time check every other ``timezone`` field carries.
Calling them directly is therefore the only way to prove they behave like their
``CalendarSerializer`` sibling rather than merely existing.
"""

from __future__ import annotations

import pytest
from rest_framework import serializers

from trueppm_api.apps.sync.serializers import (
    SyncCalendarSerializer,
    SyncTaskRecurrenceRuleSerializer,
)

SYNC_TIMEZONE_SERIALIZERS = [SyncCalendarSerializer, SyncTaskRecurrenceRuleSerializer]


@pytest.mark.parametrize("serializer_cls", SYNC_TIMEZONE_SERIALIZERS)
class TestSyncTimezoneValidation:
    def test_a_known_zone_is_accepted_and_stripped(self, serializer_cls: type) -> None:
        assert serializer_cls().validate_timezone("  Europe/Berlin  ") == "Europe/Berlin"

    @pytest.mark.parametrize("bad", ["Pacific Time", "GMT+5", "Mars/Olympus", "not a zone"])
    def test_a_non_iana_zone_is_rejected(self, serializer_cls: type, bad: str) -> None:
        with pytest.raises(serializers.ValidationError, match="Unknown IANA timezone"):
            serializer_cls().validate_timezone(bad)

    @pytest.mark.parametrize("blank", ["", "   "])
    def test_a_blank_zone_is_rejected(self, serializer_cls: type, blank: str) -> None:
        # Neither synced model has an inherit sentinel: both default to "UTC" and every
        # reader substitutes UTC for a blank, so storing "" would read back as nothing.
        with pytest.raises(serializers.ValidationError, match="Unknown IANA timezone"):
            serializer_cls().validate_timezone(blank)
