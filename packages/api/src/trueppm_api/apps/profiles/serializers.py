"""Serializers for the profiles app (ADR-0129, ADR-0139)."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from trueppm_api.apps.profiles.constants import HIDEABLE_VIEW_KEYS
from trueppm_api.apps.profiles.models import UserProfile


class UserProfileSerializer(serializers.ModelSerializer[UserProfile]):
    """Read/write the caller's own app preferences.

    ``default_landing`` and ``role_context`` choice validation is enforced by the
    model fields' ``choices`` (DRF rejects an out-of-range value with 400).
    ``hidden_views`` is a bounded list of canonical view keys (ADR-0139);
    ``validate_hidden_views`` rejects unknown keys and de-duplicates.
    ``RETIRED_FIELDS`` are 400-rejected by name (see ``validate``).
    ``timezone`` / ``date_format`` are the personal display frame (#1953, ADR-0410):
    ``date_format`` choice validation is enforced by the model field's ``choices``;
    ``timezone`` is validated below against stdlib ``zoneinfo`` (``"auto"`` accepted).
    """

    # max_length on both the list and the child bound the payload so a worker can
    # never interpolate an attacker-supplied giant list into the error string
    # (same DoS guard as ProgramRollupConfigSerializer.enabled_kpis).
    hidden_views = serializers.ListField(
        child=serializers.CharField(max_length=32),
        max_length=32,
        required=False,
    )

    #: Preference keys this endpoint used to accept and no longer does.
    #:
    #: DRF's ``to_internal_value`` iterates *declared fields* and pulls each one out of
    #: the payload, so a key matching no field is never enumerated — a stale client
    #: PATCHing a removed preference gets a ``200`` and no indication that the write
    #: evaporated. An agent's default reading of ``200`` on a PATCH is "my write
    #: landed", and the only counter-signal is the *absence* of a key in the response,
    #: which nothing obliges a caller to check.
    #:
    #: That is the same dishonesty ADR-0942 §3 removed the field to avoid, with the
    #: mechanism inverted: the no-op field lied by echoing ``true``, and a silently
    #: dropped key lies by echoing nothing. §3 asks for "deletion and a ``400`` on a
    #: stale write", so the refusal is explicit and names the key.
    #:
    #: Deliberately a NAMED DENYLIST, not general strict mode: rejecting every unknown
    #: key would make any additive client change a hard failure and break
    #: forward-compatibility. Only keys this endpoint genuinely retired belong here.
    #: An entry may be dropped once no deployed client could still be sending it.
    RETIRED_FIELDS: dict[str, str] = {
        # ADR-0942 §3 / #3137 — the Schedule-in-Deliver placement opt-in. Every view
        # now has exactly one home in the rail, so there is nothing left to place.
        "schedule_in_deliver": (
            "The Schedule-in-Deliver placement preference was removed in 0.4 "
            "(ADR-0942): every view now appears in exactly one navigation band. "
            "Remove this key from your request."
        ),
    }

    class Meta:
        model = UserProfile
        fields = [
            "default_landing",
            "role_context",
            "hidden_views",
            "timezone",
            "date_format",
        ]

    def validate_timezone(self, value: str) -> str:
        # Accept the "auto" sentinel (resolved client-side to the browser zone);
        # otherwise require a real IANA zone. Reuse the codebase precedent:
        # ZoneInfo(value) in a try/except, NOT available_timezones() membership —
        # it accepts exactly the OS-tzdata strings the client's Intl…timeZone emits
        # and rejects an unknown zone with a DRF-standard 400 field error.
        #
        # Peers carrying the same validator: TaskRecurrenceRule, Project, Workspace.
        # This list used to name Calendar as well, which never had one and still does
        # not (#3398) — and Project/Workspace only gained theirs in #3377, so it was
        # describing an intent rather than the tree.
        if value == "auto":
            return value
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise serializers.ValidationError("Unknown IANA timezone.") from exc
        return value

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # Object-level so it can see keys DRF's field loop never looks at: by the time
        # `attrs` exists the retired key is already gone, so the check must read
        # `initial_data` (the raw payload). Guarded with `hasattr` because a serializer
        # constructed for *output* only (no `data=`) has no `initial_data`.
        raw = getattr(self, "initial_data", None)
        if isinstance(raw, dict):
            retired = [k for k in self.RETIRED_FIELDS if k in raw]
            if retired:
                raise serializers.ValidationError({k: [self.RETIRED_FIELDS[k]] for k in retired})
        return attrs

    def validate_hidden_views(self, value: list[str]) -> list[str]:
        unknown = [v for v in value if v not in HIDEABLE_VIEW_KEYS]
        if unknown:
            preview = ", ".join(sorted(unknown)[:5])
            suffix = f" (+{len(unknown) - 5} more)" if len(unknown) > 5 else ""
            raise serializers.ValidationError(
                f"Unknown or non-hideable view key(s): {preview}{suffix}. "
                f"Expected one of: {', '.join(sorted(HIDEABLE_VIEW_KEYS))}."
            )
        # De-duplicate while preserving caller order — the hidden set is a set in
        # spirit; storing duplicates would be harmless but noisy.
        seen: set[str] = set()
        deduped: list[str] = []
        for v in value:
            if v not in seen:
                seen.add(v)
                deduped.append(v)
        return deduped

    def update(self, instance: UserProfile, validated_data: dict[str, Any]) -> UserProfile:
        update_fields: list[str] = []
        if "default_landing" in validated_data:
            instance.default_landing = validated_data["default_landing"]
            update_fields.append("default_landing")
        if "role_context" in validated_data:
            instance.role_context = validated_data["role_context"]
            update_fields.append("role_context")
        if "hidden_views" in validated_data:
            instance.hidden_views = validated_data["hidden_views"]
            update_fields.append("hidden_views")
        if "timezone" in validated_data:
            instance.timezone = validated_data["timezone"]
            update_fields.append("timezone")
        if "date_format" in validated_data:
            instance.date_format = validated_data["date_format"]
            update_fields.append("date_format")
        if update_fields:
            instance.save(update_fields=update_fields)
        return instance


class RecentProjectSerializer(serializers.Serializer[Any]):
    """One recently-visited project for the ⌘K "Recent" group (ADR-0508, #1557).

    Serializes a :class:`~trueppm_api.apps.profiles.models.ProjectVisit` row into
    the flat shape the palette renders: the project identity plus its program
    breadcrumb (for cross-program disambiguation — two projects can share a name
    across programs) and the ``visited_at`` recency hint. Read-only; the program
    fields are method-computed so a project with no program (``program`` is
    ``SET_NULL``) serializes cleanly to ``null`` rather than raising.
    """

    id = serializers.UUIDField(source="project.id", read_only=True)
    name = serializers.CharField(source="project.name", read_only=True)
    program_id = serializers.SerializerMethodField()
    program_name = serializers.SerializerMethodField()
    visited_at = serializers.DateTimeField(read_only=True)

    def get_program_id(self, visit: Any) -> str | None:
        return str(visit.project.program_id) if visit.project.program_id else None

    def get_program_name(self, visit: Any) -> str | None:
        return visit.project.program.name if visit.project.program_id else None


class PinnedItemSerializer(serializers.Serializer[Any]):
    """One entry in ``GET /auth/me/pinned/`` — a project or a program (#2390).

    A merged shape rather than two lists: the rail renders one flat jump group,
    and ``kind`` is what the client switches on for the route and the glyph.

    ``pinned_at`` appears on this serializer and nowhere else. It is the caller's
    own timestamp on their own pin; putting it on a shared Project/Program
    payload would make "she hasn't pinned it in weeks" expressible to a
    teammate, which ADR-0627 §D5 forecloses.
    """

    # Plain CharField (not ChoiceField), matching the same decision on
    # `UnifiedSearchResultSerializer.kind`: a ChoiceField emits a `KindEnum`
    # component that collides with the existing AssetItem `kind` (file/link) and
    # makes drf-spectacular rename BOTH — silently turning the long-stable
    # `KindEnum` into `AssetItemKindEnum` and breaking every generated client
    # that referenced it. The two values live in `help_text` instead.
    kind = serializers.CharField(
        help_text="Pinned target: 'project' or 'program'.",
    )
    id = serializers.CharField()
    name = serializers.CharField()
    # Programs carry a short code; projects do not.
    code = serializers.CharField(allow_null=True)
    # Parent program of a pinned project, for the "Program › Project" breadcrumb.
    # Null on a pinned program (it has no parent) and on a standalone project.
    program_id = serializers.CharField(allow_null=True)
    program_name = serializers.CharField(allow_null=True)
    pinned_at = serializers.DateTimeField()
