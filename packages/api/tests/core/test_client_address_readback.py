"""Client-address readback for the per-IP throttles (#4020).

``TRUEPPM_NUM_PROXIES`` must equal the number of proxies in front of Django, and
nothing else checks it. These tests pin the readback that makes it checkable:
``resolved`` is exactly what the throttles key on, and ``status`` flags the
misconfigurations one request can prove.
"""

from __future__ import annotations

import importlib
import os
from collections.abc import Iterator
from typing import Any
from unittest import mock

import pytest
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.test import RequestFactory, override_settings

from trueppm_api.core.throttling import (
    LoginIpRateThrottle,
    ProbeExemptAnonRateThrottle,
    describe_client_address,
)
from trueppm_api.settings import base

PUBLIC_CLIENT = "93.184.216.34"
PROXY_POD = "10.42.0.17"
LB = "10.0.3.9"


def _num_proxies(n: int | None) -> Any:
    return override_settings(REST_FRAMEWORK={**settings.REST_FRAMEWORK, "NUM_PROXIES": n})


def _request(xff: str | None = None, remote_addr: str = PROXY_POD) -> Any:
    extra: dict[str, str] = {"REMOTE_ADDR": remote_addr}
    if xff is not None:
        extra["HTTP_X_FORWARDED_FOR"] = xff
    return RequestFactory().get("/api/v1/health/system/", **extra)


class TestResolvedMatchesTheThrottles:
    """``resolved`` must be what the throttles key on, or the readback lies."""

    @pytest.mark.parametrize("num_proxies", [0, 1, 2, 3])
    def test_resolved_equals_throttle_ident(self, num_proxies: int) -> None:
        req = _request(f"198.51.100.1, {PUBLIC_CLIENT}, {LB}")
        with _num_proxies(num_proxies):
            readback = describe_client_address(req)
            assert readback["resolved"] == ProbeExemptAnonRateThrottle().get_ident(req)
            assert LoginIpRateThrottle.cache_key_for_request(req).endswith(
                f"_{readback['resolved']}"
            )

    def test_two_hop_chain_resolves_the_visitor(self) -> None:
        # LB -> ingress -> API with the chain preserved: two proxy-written entries
        # after the visitor, and NUM_PROXIES=2 lands on the visitor.
        with _num_proxies(2):
            readback = describe_client_address(_request(f"{PUBLIC_CLIENT}, {LB}"))
        assert readback["resolved"] == PUBLIC_CLIENT
        assert readback["status"] == "ok"
        assert readback["num_proxies"] == 2
        assert readback["remote_addr"] == PROXY_POD
        assert readback["forwarded_for"] == [PUBLIC_CLIENT, LB]
        assert readback["forwarded_for_entries"] == 2


class TestStatus:
    def test_no_proxy_topology_at_default_depth_is_flagged(self) -> None:
        """Direction B, the dev-compose shape: nothing in front, NUM_PROXIES=1.

        An honest client sends no X-Forwarded-For, so the chain is shorter than
        the configured depth — the one request shape that proves a client could
        have supplied the address instead.
        """
        with _num_proxies(1):
            readback = describe_client_address(_request(None, remote_addr=PUBLIC_CLIENT))
        assert readback["status"] == "fewer_hops_than_configured"
        assert "TRUEPPM_NUM_PROXIES is 1" in readback["detail"]

    def test_chain_shorter_than_depth_is_flagged(self) -> None:
        with _num_proxies(2):
            readback = describe_client_address(_request(PUBLIC_CLIENT))
        assert readback["status"] == "fewer_hops_than_configured"
        # DRF falls back to the leftmost entry — which the client wrote.
        assert readback["resolved"] == PUBLIC_CLIENT

    def test_header_ignored_at_zero(self) -> None:
        with _num_proxies(0):
            readback = describe_client_address(_request(PUBLIC_CLIENT))
        assert readback["status"] == "forwarded_for_ignored"
        assert readback["resolved"] == PROXY_POD

    def test_zero_with_no_header_and_public_peer_is_ok(self) -> None:
        with _num_proxies(0):
            readback = describe_client_address(_request(None, remote_addr=PUBLIC_CLIENT))
        assert readback["status"] == "ok"
        assert readback["resolved"] == PUBLIC_CLIENT

    def test_proxy_address_resolved_is_non_public(self) -> None:
        """Direction A, LB in front of ingress at depth 1: the LB's address wins."""
        with _num_proxies(1):
            readback = describe_client_address(_request(LB))
        assert readback["status"] == "non_public"
        assert readback["resolved"] == LB

    def test_unparsable_resolved(self) -> None:
        with _num_proxies(1):
            readback = describe_client_address(_request(f"{PUBLIC_CLIENT}, unknown"))
        assert readback["status"] == "unparsable"

    def test_unset_depth_is_flagged(self) -> None:
        with _num_proxies(None):
            readback = describe_client_address(_request(PUBLIC_CLIENT))
        assert readback["status"] == "fewer_hops_than_configured"
        assert "unset" in readback["detail"]


class TestEchoIsBounded:
    def test_long_chain_and_long_entries_are_truncated(self) -> None:
        chain = ", ".join(["x" * 500] * 40 + [PUBLIC_CLIENT])
        with _num_proxies(1):
            readback = describe_client_address(_request(chain))
        assert readback["forwarded_for_entries"] == 41
        assert len(readback["forwarded_for"]) == 16
        assert all(len(entry) <= 64 for entry in readback["forwarded_for"])
        # The tail — the proxy-written end — is what is kept.
        assert readback["forwarded_for"][-1] == PUBLIC_CLIENT

    def test_resolved_is_truncated(self) -> None:
        with _num_proxies(1):
            readback = describe_client_address(_request("y" * 500))
        assert len(readback["resolved"]) == 64


class TestSettingValidation:
    """A negative depth indexes X-Forwarded-For from the client-written end."""

    @pytest.fixture(autouse=True)
    def _restore_base(self) -> Iterator[None]:
        yield
        importlib.reload(base)

    def test_negative_refuses_to_boot(self) -> None:
        with (
            mock.patch.dict(os.environ, {"TRUEPPM_NUM_PROXIES": "-1"}),
            pytest.raises(ImproperlyConfigured, match="TRUEPPM_NUM_PROXIES"),
        ):
            importlib.reload(base)

    @pytest.mark.parametrize("value", ["0", "2"])
    def test_non_negative_is_accepted(self, value: str) -> None:
        with mock.patch.dict(os.environ, {"TRUEPPM_NUM_PROXIES": value}):
            importlib.reload(base)
            assert base.REST_FRAMEWORK["NUM_PROXIES"] == int(value)
