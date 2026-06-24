"""API tests for HTTP Idempotency-Key support (ADR-0170).

Covers the four acceptance behaviors — replay, mismatched-hash 422, missing-key no-op,
expired-key re-run — plus exemptions, safe-method no-op, and a URLconf enforcement test
asserting every unsafe-method TruePPM view carries the mixin.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.urls import URLPattern, URLResolver, get_resolver
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.idempotency.models import IdempotencyKey
from trueppm_api.apps.idempotency.tasks import _do_purge
from trueppm_api.apps.projects.models import Calendar, Project, Task

KEY = "11111111-1111-1111-1111-111111111111"
TASKS_URL = "/api/v1/tasks/"


@pytest.fixture
def user(db: object) -> object:
    return get_user_model().objects.create_user(username="idem-user", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(
        name="Idem Project", start_date=date(2026, 4, 1), calendar=calendar
    )


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)


def _payload(project: Project, name: str = "Build") -> dict[str, object]:
    return {"project": str(project.pk), "name": name, "duration": 3}


# ---------------------------------------------------------------------------
# Core behaviors
# ---------------------------------------------------------------------------


class TestIdempotentReplay:
    def test_missing_key_is_noop(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        res = client.post(TASKS_URL, _payload(project), format="json")
        assert res.status_code == 201
        assert IdempotencyKey.objects.count() == 0  # no header → no row

    def test_replay_returns_stored_response_and_skips_second_write(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        first = client.post(TASKS_URL, _payload(project), format="json", HTTP_IDEMPOTENCY_KEY=KEY)
        assert first.status_code == 201
        assert Task.objects.count() == 1
        assert IdempotencyKey.objects.filter(key=KEY, status="completed").count() == 1

        second = client.post(TASKS_URL, _payload(project), format="json", HTTP_IDEMPOTENCY_KEY=KEY)
        assert second.status_code == 201
        assert second["Idempotent-Replay"] == "true"
        assert second.json()["id"] == first.json()["id"]  # same stored body
        assert Task.objects.count() == 1  # the retry did NOT create a second task

    def test_mismatched_hash_returns_422(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        first = client.post(
            TASKS_URL, _payload(project, "A"), format="json", HTTP_IDEMPOTENCY_KEY=KEY
        )
        assert first.status_code == 201

        # Same key, different body → conflict, and no second write.
        conflict = client.post(
            TASKS_URL, _payload(project, "B"), format="json", HTTP_IDEMPOTENCY_KEY=KEY
        )
        assert conflict.status_code == 422
        assert "reused" in conflict.json()["detail"]
        assert Task.objects.count() == 1

    def test_safe_method_is_noop(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        res = client.get(f"{TASKS_URL}?project={project.pk}", HTTP_IDEMPOTENCY_KEY=KEY)
        assert res.status_code == 200
        assert IdempotencyKey.objects.count() == 0

    def test_key_is_scoped_per_user(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        client.post(TASKS_URL, _payload(project), format="json", HTTP_IDEMPOTENCY_KEY=KEY)

        # A different user reusing the same key value is independent (no replay,
        # no cross-user response leak) — it creates its own task and row.
        other = get_user_model().objects.create_user(username="other", password="pw")
        ProjectMembership.objects.create(project=project, user=other, role=Role.ADMIN)
        other_client = APIClient()
        other_client.force_authenticate(user=other)

        res = other_client.post(
            TASKS_URL, _payload(project), format="json", HTTP_IDEMPOTENCY_KEY=KEY
        )
        assert res.status_code == 201
        assert Task.objects.count() == 2
        assert IdempotencyKey.objects.filter(key=KEY).count() == 2

    def test_validation_error_is_not_cached(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        # An exception-driven 4xx triggers DRF set_rollback(), so the request transaction
        # (and the claim row) rolls back: nothing is stored, and a retry re-runs rather than
        # replaying a cached error.
        bad = {"project": str(project.pk), "duration": 3}  # missing required name
        first = client.post(TASKS_URL, bad, format="json", HTTP_IDEMPOTENCY_KEY=KEY)
        assert first.status_code == 400
        assert IdempotencyKey.objects.filter(key=KEY).count() == 0

        second = client.post(TASKS_URL, bad, format="json", HTTP_IDEMPOTENCY_KEY=KEY)
        assert second.status_code == 400
        assert second.get("Idempotent-Replay") is None  # re-ran, not replayed


# ---------------------------------------------------------------------------
# Exemptions
# ---------------------------------------------------------------------------


class TestExemptions:
    def test_exempt_view_does_not_store(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        # ProjectApiTokenViewSet is exempt (its create returns a one-time plaintext
        # token that must never be persisted for replay).
        res = client.post(
            f"/api/v1/projects/{project.pk}/api-tokens/",
            {"name": "ci"},
            format="json",
            HTTP_IDEMPOTENCY_KEY=KEY,
        )
        assert res.status_code == 201
        assert IdempotencyKey.objects.count() == 0


# ---------------------------------------------------------------------------
# Retention purge
# ---------------------------------------------------------------------------


class TestPurge:
    def test_purge_deletes_expired_keeps_recent(self, user: object, db: object) -> None:
        recent = IdempotencyKey.objects.create(
            user=user, key="recent", method="POST", path="/x", request_hash="h", status="completed"
        )
        old = IdempotencyKey.objects.create(
            user=user, key="old", method="POST", path="/x", request_hash="h", status="completed"
        )
        # auto_now_add ignores the constructor; backdate via queryset update.
        IdempotencyKey.objects.filter(pk=old.pk).update(
            created_at=timezone.now() - timedelta(hours=48)
        )

        deleted = _do_purge(retention_hours=24)
        assert deleted == 1
        assert IdempotencyKey.objects.filter(pk=recent.pk).exists()
        assert not IdempotencyKey.objects.filter(pk=old.pk).exists()


# ---------------------------------------------------------------------------
# Coverage enforcement — the teeth against silent gaps (ADR-0170)
# ---------------------------------------------------------------------------


def _iter_view_classes() -> list[tuple[str, str | None, type, set[str]]]:
    """Yield (route, url_name, view_class, unsafe_methods) for every TruePPM-owned URL."""
    unsafe = {"post", "put", "patch", "delete"}
    results: list[tuple[str, str | None, type, set[str]]] = []

    def walk(patterns: list[object], prefix: str) -> None:
        for p in patterns:
            if isinstance(p, URLResolver):
                walk(p.url_patterns, prefix + str(p.pattern))
            elif isinstance(p, URLPattern):
                cb = p.callback
                cls = getattr(cb, "cls", None) or getattr(cb, "view_class", None)
                if cls is None or not cls.__module__.startswith("trueppm_api"):
                    continue
                # ViewSets expose the method→action map via as_view(actions=...).
                actions = getattr(cb, "actions", None)
                if actions:
                    methods = {m for m in actions if m in unsafe}
                else:
                    methods = {m for m in unsafe if callable(getattr(cls, m, None))}
                if methods:
                    results.append((prefix + str(p.pattern), p.name, cls, methods))

    walk(get_resolver().url_patterns, "")
    return results


# Function-based (@api_view) endpoints cannot carry the mixin via inheritance, so they are
# allowlisted by URL name (their @api_view wrapper class is always "WrappedAPIView", which
# is not distinguishable). All are intentionally not idempotency-protected (ADR-0170):
# - project-schedule (trigger_schedule) is already deduped by the ScheduleRequest outbox;
# - project-monte-carlo (run_monte_carlo) is a read-only simulation that writes no state;
# - retention-settings (retention_settings PATCH) updates a singleton config, so replaying it
#   converges to the same state (naturally idempotent);
# - retention-runs (retention_runs POST) carries its own end-to-end single-flight 409 guard
#   (RETENTION_PURGE_INFLIGHT_SECONDS), so a rapid double-click can't mint duplicate runs;
# - token_obtain_pair (ThrottledTokenObtainPairView POST, #770) is the login endpoint: it
#   mints fresh JWTs and persists no replayable resource, so idempotency keys don't apply —
#   abuse is bounded by the scoped login throttle instead;
# - token_refresh (ThrottledTokenRefreshView POST, #814) is the refresh endpoint and has the
#   same shape as login — it mints a fresh access JWT and persists no replayable resource,
#   so idempotency keys don't apply; abuse is bounded by the scoped `refresh` throttle;
# - token_logout (CookieTokenLogoutView POST, #897) is naturally idempotent: it clears the
#   refresh cookie and best-effort blacklists the token, so replaying it converges to the same
#   logged-out state — mirroring the token_obtain_pair / token_refresh exemptions.
# - project-signal-privacy (SignalPrivacyPolicyView PATCH, ADR-0104 / #553) sets one signal's
#   audience on the per-project policy singleton; setting the current value short-circuits to a
#   no-op (no history row), so replaying converges to the same posture — the retention-settings
#   shape (naturally idempotent);
# - project-signal-privacy-raise-ceiling (SignalPrivacyRaiseCeilingView POST) sets one signal's
#   ceiling on the same singleton with the identical no-op-on-unchanged guard, so a replay writes
#   no duplicate audit row and converges to the same ceiling (naturally idempotent);
# - project-signal-privacy-ratchet-down (SignalPrivacyRatchetDownView POST) sets every signal's
#   audience to TEAM in one converging write on the singleton — replaying lands on the same
#   all-team posture (naturally idempotent).
# - project-signal-ceiling-proposal-vote (SignalCeilingProposalVoteView POST, ADR-0104 Amendment
#   A / #930) upserts the caller's one vote (unique(proposal, voter)) and tallies behind a
#   status guard (the apply runs once on OPEN->RATIFIED); replaying the same vote converges to
#   the same vote, and a replay after the proposal resolves is a 409, never a duplicate effect;
# - project-signal-ceiling-proposal-withdraw (SignalCeilingProposalWithdrawView POST) resolves an
#   OPEN proposal to REJECTED behind the same status guard — a replay is a 409 (no longer open),
#   so it converges to the same withdrawn state (naturally idempotent).
# - auth-me-profile (MyProfileView PATCH, ADR-0129 / #1181) sets the caller's own
#   default_landing on their UserProfile singleton; setting the current value is a no-op and a
#   replay converges to the same stored preference — the same naturally-idempotent
#   retention-settings shape, with no replayable resource to dedup.
# - project-decisions-policy (ProjectDecisionsPolicyView PATCH, ADR-0167 / #748) sets the single
#   oversight_visible boolean on the project's decisions-visibility policy singleton; setting the
#   current value is a no-op and a replay converges to the same posture — the same naturally-
#   idempotent settings-toggle shape as the signal-privacy views, with no replayable resource.
# - sprint-poker / poker-vote / poker-reveal / poker-reopen / poker-commit / poker-cancel
#   (estimation poker, ADR-0179 / #863) are the same ceremony shape as the signal-privacy votes:
#   each runs under select_for_update + a status guard so a replay converges (vote is an upsert on
#   unique(session, voter); reveal/reopen/commit/cancel are guarded state transitions; open is
#   guarded by the poker_one_live_per_task partial-unique). No replayable resource to dedup.
EXEMPT_URL_NAMES = frozenset(
    {
        "project-schedule",
        "project-monte-carlo",
        "retention-settings",
        "retention-runs",
        "token_obtain_pair",
        "token_refresh",
        "token_logout",
        "project-signal-privacy",
        "project-signal-privacy-raise-ceiling",
        "project-signal-privacy-ratchet-down",
        "project-signal-ceiling-proposal-vote",
        "project-signal-ceiling-proposal-withdraw",
        "project-decisions-policy",
        "sprint-poker",
        "poker-vote",
        "poker-reveal",
        "poker-reopen",
        "poker-commit",
        "poker-cancel",
        "auth-me-profile",
    }
)


def test_every_unsafe_view_has_idempotency_mixin() -> None:
    offenders = [
        f"{route} ({cls.__module__}.{cls.__name__}, name={name}: {sorted(methods)})"
        for route, name, cls, methods in _iter_view_classes()
        if not issubclass(cls, IdempotencyMixin) and name not in EXEMPT_URL_NAMES
    ]
    assert not offenders, (
        "These TruePPM views handle unsafe methods but lack IdempotencyMixin "
        "(add the mixin, or set idempotency_exempt=True if intentional):\n" + "\n".join(offenders)
    )
