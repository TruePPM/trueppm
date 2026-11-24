"""Serializers for the profiles app (ADR-0129, ADR-0139)."""

from __future__ import annotations

from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from trueppm_api.apps.profiles.constants import HIDEABLE_VIEW_KEYS
from trueppm_api.apps.profiles.models import RoleContext, UserProfile

#: OpenAPI shape of the deprecated ``hidden_views`` field (ADR-1478 §6.2).
HIDDEN_VIEWS_DEPRECATED_SCHEMA: dict[str, Any] = {
    "type": "array",
    "items": {"type": "string", "maxLength": 32},
    "maxItems": 32,
    "deprecated": True,
    "description": (
        "Deprecated (ADR-1478): read it from GET /projects/{id}/views/ instead. Reads "
        "return the union of your own (user-sourced) hides across your projects, never "
        "lens-seeded ones. Writes fan out as your own hides to every project you belong "
        "to. Removed one minor release after 0.5."
    ),
}


@extend_schema_field(HIDDEN_VIEWS_DEPRECATED_SCHEMA)
class DeprecatedHiddenViewsField(serializers.ListField):
    """``hidden_views``, marked ``deprecated: true`` in the schema."""


class UserProfileSerializer(serializers.ModelSerializer[UserProfile]):
    """Read/write the caller's own app preferences.

    ``default_landing`` and ``role_context`` choice validation is enforced by the
    model fields' ``choices`` (DRF rejects an out-of-range value with 400).
    ``hidden_views`` is a bounded list of canonical view keys (ADR-0139);
    ``validate_hidden_views`` rejects unknown keys and de-duplicates.
    ``RETIRED_FIELDS`` are 400-rejected by name (see ``validate``).
    ``home_override`` (``"rm"`` or null) picks the shell-v2 home; a write to
    ``default_landing`` clears it (see ``update``), so a request that sets both
    ``default_landing`` and a non-null ``home_override`` is 400-rejected (see
    ``validate``) rather than silently dropping the override.
    ``timezone`` / ``date_format`` are the personal display frame (#1953, ADR-0410):
    ``date_format`` choice validation is enforced by the model field's ``choices``;
    ``timezone`` is validated below against stdlib ``zoneinfo`` (``"auto"`` accepted).
    """

    # max_length on both the list and the child bound the payload so a worker can
    # never interpolate an attacker-supplied giant list into the error string
    # (same DoS guard as ProgramRollupConfigSerializer.enabled_kpis).
    hidden_views = DeprecatedHiddenViewsField(
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
            "home_override",
        ]

    def validate_timezone(self, value: str) -> str:
        # Accept the "auto" sentinel (resolved client-side to the browser zone);
        # otherwise require a real IANA zone. Reuse the codebase precedent:
        # ZoneInfo(value) in a try/except, NOT available_timezones() membership —
        # it accepts exactly the OS-tzdata strings the client's Intl…timeZone emits
        # and rejects an unknown zone with a DRF-standard 400 field error.
        #
        # Peers carrying the same validator: TaskRecurrenceRule, Project, Workspace,
        # Calendar, and the notification digest timezone — every ``timezone``
        # CharField with a serializer write path.
        if value == "auto":
            return value
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError, OSError) as exc:
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
        # ``update`` clears home_override on every default_landing write, so a
        # payload carrying both with a non-null override asks for two contradictory
        # outcomes; refusing it beats a 200 that quietly drops one of them. A null
        # override alongside default_landing agrees with the clear and is accepted.
        if "default_landing" in attrs and attrs.get("home_override") is not None:
            raise serializers.ValidationError(
                {
                    "home_override": [
                        "Cannot be set in the same request as default_landing, "
                        "which clears it. Send them as separate requests."
                    ]
                }
            )
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
        # A write to default_landing clears home_override (shell-v2 home amendment): the
        # newer choice wins, so a user who picks "My Work" after "Resource Manager"
        # is not silently held on the RM home. The reverse does not hold — setting
        # home_override leaves default_landing (and so the v1 front door) alone.
        if "default_landing" in validated_data:
            instance.default_landing = validated_data["default_landing"]
            update_fields.append("default_landing")
            instance.home_override = None
            update_fields.append("home_override")
        elif "home_override" in validated_data:
            instance.home_override = validated_data["home_override"]
            update_fields.append("home_override")
        if "role_context" in validated_data:
            instance.role_context = validated_data["role_context"]
            update_fields.append("role_context")
        if "hidden_views" in validated_data:
            # Keep the legacy column (the read fallback, and what a rollback sees), and
            # fan the write out per project, which is where it now takes effect.
            from trueppm_api.apps.profiles.services import fan_out_hidden_views

            instance.hidden_views = validated_data["hidden_views"]
            update_fields.append("hidden_views")
            fan_out_hidden_views(instance.user, validated_data["hidden_views"])
        if "timezone" in validated_data:
            instance.timezone = validated_data["timezone"]
            update_fields.append("timezone")
        if "date_format" in validated_data:
            instance.date_format = validated_data["date_format"]
            update_fields.append("date_format")
        if update_fields:
            instance.save(update_fields=update_fields)
        return instance

    def to_representation(self, instance: UserProfile) -> dict[str, Any]:
        from trueppm_api.apps.profiles.services import effective_hidden_views

        data = super().to_representation(instance)
        data["hidden_views"] = effective_hidden_views(instance.user, list(instance.hidden_views))
        return data


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


# ---------------------------------------------------------------------------
# Resolved project view set (ADR-1478 §5)
# ---------------------------------------------------------------------------

VIEW_SOURCE_CHOICES = ["always", "methodology", "capability", "seed", "user", "default"]
VIEW_BINDING_CHOICES = ["advisory", "enforced"]


class ResolvedViewSerializer(serializers.Serializer[Any]):
    """One view's resolved visibility and why (ADR-1478 §3).

    ``binding: enforced`` is a UI contract (the workspace turned the area off, the web
    shows AreaOff), not authorization. Never read ``visible: false`` as forbidden: an
    ``advisory`` hidden view still opens from More and by URL.
    """

    key = serializers.CharField()
    visible = serializers.BooleanField()
    # DRF's metaclass pops declared fields off the class, so shadowing Field.source is safe.
    source = serializers.ChoiceField(choices=VIEW_SOURCE_CHOICES)  # type: ignore[assignment]
    binding = serializers.ChoiceField(choices=VIEW_BINDING_CHOICES)
    lens = serializers.CharField(allow_null=True)
    at = serializers.CharField(allow_null=True)


class SeedLineSerializer(serializers.Serializer[Any]):
    """The one-time row-3 explainer: "Shown for {lens} · N views hidden" (frame 1A)."""

    lens = serializers.CharField()
    hidden_count = serializers.IntegerField()


class ProjectViewSetSerializer(serializers.Serializer[Any]):
    """``GET /projects/{id}/views/``: the caller's own resolved view set.

    ``lens`` is the caller's current role lens; ``seeded_lens`` is the lens whose seed
    is in effect (null when none). ``lens_offer`` is set when they differ and the
    "Apply {lens} suggestions" offer has not been dismissed. ``landing`` is the view the
    current lens opens on for this methodology, or null when it is hidden.
    """

    views = ResolvedViewSerializer(many=True)
    lens = serializers.CharField()
    seeded_lens = serializers.CharField(allow_null=True)
    seed_line = SeedLineSerializer(allow_null=True)
    lens_offer = serializers.CharField(allow_null=True)
    landing = serializers.CharField(allow_null=True)
    last_layouts = serializers.DictField(child=serializers.CharField())


class ProjectViewsPatchSerializer(serializers.Serializer[Any]):
    """``PATCH /projects/{id}/views/``: change the caller's own view state.

    ``{key, hidden}`` records the caller's own choice for one view. ``clear_seed: true``
    is the row-3 "Show all": it drops only this project's seed hides.
    """

    key = serializers.ChoiceField(choices=sorted(HIDEABLE_VIEW_KEYS), required=False)
    hidden = serializers.BooleanField(required=False)
    seed_line_dismissed = serializers.BooleanField(required=False)
    lens_offer_dismissed = serializers.ChoiceField(choices=RoleContext.choices, required=False)
    clear_seed = serializers.BooleanField(required=False)
    last_layouts = serializers.DictField(child=serializers.CharField(max_length=32), required=False)

    def validate_last_layouts(self, value: dict[str, str]) -> dict[str, str]:
        if len(value) > 8 or any(len(k) > 32 for k in value):
            raise serializers.ValidationError("At most 8 entries with keys of 32 characters.")
        return value

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if ("key" in attrs) != ("hidden" in attrs):
            raise serializers.ValidationError({"key": ["Send key and hidden together."]})
        if not attrs:
            raise serializers.ValidationError("Send at least one field.")
        return attrs


class ApplySeedRequestSerializer(serializers.Serializer[Any]):
    """``POST …/views/apply-seed/``: preview (``dry_run``, the default) or apply."""

    lens = serializers.ChoiceField(choices=RoleContext.choices)
    dry_run = serializers.BooleanField(default=True)


class KeptViewSerializer(serializers.Serializer[Any]):
    view = serializers.CharField()
    hidden = serializers.BooleanField()


class SeedDiffSerializer(serializers.Serializer[Any]):
    """The lens-change confirm (frame 1C): Will hide · Will open on · Kept.

    Only ``seed`` entries change. ``kept`` lists the caller's own choices, which an
    apply never touches. ``change_count`` labels the "Apply N changes" action.
    """

    lens = serializers.CharField()
    will_hide = serializers.ListField(child=serializers.CharField())
    will_show = serializers.ListField(child=serializers.CharField())
    will_open_on = serializers.CharField(allow_null=True)
    kept = KeptViewSerializer(many=True)
    change_count = serializers.IntegerField()
    applied = serializers.BooleanField()
