"""The operator base-URL allow-list is actually read (#2860).

``providers.assert_base_url_allowed`` gates which host a user may attach a personal
credential to, and its rejection message names ``TRUEPPM_INTEGRATION_ALLOWED_HOSTS``
as the escape hatch. That env var was **bound by no settings module** — the read was
``getattr(settings, "TRUEPPM_INTEGRATION_ALLOWED_HOSTS", None)``, an attribute nothing
ever defined, so it always fell back to ``None``.

The allow-list fails **closed**, so the bug was the inverse of a security hole: an
operator with a legitimately self-hosted Jira Data Center or GitLab CE could not
connect it at all, and the error told them to set a variable that was never read. It
was documented in four places throughout.

There were also no tests on this function, which is the second half of why it went
unnoticed for so long.
"""

from __future__ import annotations

import pytest
from django.test import override_settings

from trueppm_api.apps.integrations.providers import BaseUrlNotAllowed, assert_base_url_allowed


class TestDefaultHosts:
    """The always-allowed cloud hosts need no allow-list entry."""

    @pytest.mark.parametrize(
        "base_url",
        [
            "https://acme.atlassian.net",
            "https://atlassian.net",
        ],
    )
    def test_jira_cloud_is_allowed(self, base_url: str) -> None:
        assert_base_url_allowed("jira", base_url)

    def test_a_self_hosted_host_is_rejected_by_default(self) -> None:
        with pytest.raises(BaseUrlNotAllowed):
            assert_base_url_allowed("jira", "https://jira.example.com")

    def test_the_rejection_names_the_env_var_an_operator_must_set(self) -> None:
        """The message is the operator's only pointer to the escape hatch."""
        with pytest.raises(BaseUrlNotAllowed, match="TRUEPPM_INTEGRATION_ALLOWED_HOSTS"):
            assert_base_url_allowed("jira", "https://jira.example.com")


class TestOperatorAllowList:
    """The setting is bound and consulted — before #2860 none of this worked."""

    @override_settings(INTEGRATION_ALLOWED_HOSTS=["jira.example.com"])
    def test_an_allow_listed_self_hosted_host_is_accepted(self) -> None:
        assert_base_url_allowed("jira", "https://jira.example.com")

    @override_settings(INTEGRATION_ALLOWED_HOSTS=["JIRA.EXAMPLE.COM"])
    def test_matching_is_case_insensitive(self) -> None:
        assert_base_url_allowed("jira", "https://jira.example.com")

    @override_settings(INTEGRATION_ALLOWED_HOSTS=["jira.example.com"])
    def test_a_host_not_on_the_list_is_still_rejected(self) -> None:
        with pytest.raises(BaseUrlNotAllowed):
            assert_base_url_allowed("jira", "https://other.example.com")

    @override_settings(INTEGRATION_ALLOWED_HOSTS=["jira.example.com"])
    def test_the_list_is_not_a_suffix_match(self) -> None:
        """An entry must not admit an attacker-registered lookalike domain."""
        with pytest.raises(BaseUrlNotAllowed):
            assert_base_url_allowed("jira", "https://evil-jira.example.com.attacker.test")

    @override_settings(INTEGRATION_ALLOWED_HOSTS=[])
    def test_an_empty_list_is_the_shipped_default_and_denies(self) -> None:
        with pytest.raises(BaseUrlNotAllowed):
            assert_base_url_allowed("jira", "https://jira.example.com")


def test_the_setting_exists_on_the_settings_module() -> None:
    """Pin the binding itself.

    Reading a name no settings module defines is exactly the defect: ``getattr``
    with a default silently degrades to "deny everything self-hosted" instead of
    raising, so nothing anywhere reported that the control was dead.
    """
    from django.conf import settings

    assert isinstance(settings.INTEGRATION_ALLOWED_HOSTS, list)
