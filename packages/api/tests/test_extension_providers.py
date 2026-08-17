"""Single-provider extension hooks reject a silent second registration (#2859).

Six hooks are a module-global ``Callable | None`` with an unconditional-assignment
setter, unlike ``ProviderRegistry.register`` which raises on a duplicate key. Two
registrations used to silently overwrite, making the winner import order — and the
symptom of losing that race is an enforcement policy that quietly stops applying,
with nothing in any log.

OSS registers none of these, so the realistic conflict is an Enterprise build
registering twice: an ``AppConfig.ready()`` that runs more than once, or two apps
that each think they own the hook.
"""

from __future__ import annotations

import pytest

from trueppm_api.apps.profiles import services as profile_services
from trueppm_api.apps.projects import (
    calendar_settings,
    iteration_label,
    methodology,
    sharing_settings,
    signal_privacy_services,
)
from trueppm_api.core.extension_providers import DuplicateProviderError, guard_single_provider

# (module, register_fn_name) for each single-provider hook that takes one callable.
_SINGLE_PROVIDER_HOOKS = [
    (iteration_label, "register_terminology_enforcement_provider"),
    (calendar_settings, "register_calendar_enforcement_provider"),
    (sharing_settings, "register_sharing_enforcement_provider"),
    (methodology, "register_methodology_enforcement_provider"),
    (signal_privacy_services, "register_default_posture_provider"),
]


class TestGuardSemantics:
    def test_registering_into_an_empty_hook_is_allowed(self) -> None:
        provider = object()
        assert guard_single_provider(None, provider, "hook") is provider

    def test_clearing_is_always_allowed(self) -> None:
        """Every test teardown in the suite clears by registering ``None``."""
        assert guard_single_provider(object(), None, "hook") is None

    def test_re_registering_the_same_provider_is_a_no_op(self) -> None:
        """An idempotent ``AppConfig.ready()`` must not be punished for running twice."""
        provider = object()
        assert guard_single_provider(provider, provider, "hook") is provider

    def test_a_different_provider_raises(self) -> None:
        with pytest.raises(DuplicateProviderError, match="already has a provider"):
            guard_single_provider(object(), object(), "calendar enforcement")

    def test_the_error_names_the_hook(self) -> None:
        with pytest.raises(DuplicateProviderError, match="calendar enforcement"):
            guard_single_provider(object(), object(), "calendar enforcement")


@pytest.mark.parametrize(("module", "register"), _SINGLE_PROVIDER_HOOKS)
class TestEveryHookIsGuarded:
    def test_a_conflicting_second_registration_raises(self, module: object, register: str) -> None:
        register_fn = getattr(module, register)
        register_fn(lambda: True)
        try:
            with pytest.raises(DuplicateProviderError):
                register_fn(lambda: False)
        finally:
            register_fn(None)

    def test_register_then_clear_then_register_works(self, module: object, register: str) -> None:
        """The clear path must stay usable, or every teardown in the suite breaks."""
        register_fn = getattr(module, register)
        register_fn(lambda: True)
        register_fn(None)
        register_fn(lambda: False)
        register_fn(None)


def test_the_two_callable_portfolio_hook_is_guarded() -> None:
    """``register_portfolio_access_provider`` takes two callables and guards both."""
    profile_services.register_portfolio_access_provider(lambda _u: True, lambda _u: "/p")
    try:
        with pytest.raises(DuplicateProviderError):
            profile_services.register_portfolio_access_provider(
                lambda _u: False, lambda _u: "/other"
            )
    finally:
        profile_services._portfolio_access_provider = None
        profile_services._portfolio_path_provider = None
