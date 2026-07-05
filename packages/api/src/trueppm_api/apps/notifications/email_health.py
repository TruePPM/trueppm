"""Deliverability (SPF / DKIM / DMARC) health checks for the From domain.

Live DNS TXT lookups for the workspace From-address domain (#712, ADR-0213 §4).
Bounded and defensive per the security review (M4): a short per-query timeout, a
capped number of records, TXT-only lookups (never opens a connection to the
domain), and the target domain is derived solely from the *persisted, validated*
``from_email`` — never from request input. The endpoint is operator-gated and
throttled by the caller.

Each check returns ``pass`` / ``warn`` / ``fail``. When the DNS resolver is
unavailable the whole surface degrades to ``available = False`` rather than
erroring, so a resolver-less host shows "checks unavailable" instead of a
failure.
"""

from __future__ import annotations

import logging
from typing import TypedDict

logger = logging.getLogger(__name__)

# Bound every lookup: a slow/hostile authoritative resolver must not hang the
# request, and an oversized TXT set must not balloon the response.
_DNS_TIMEOUT_SECONDS = 3.0
_MAX_TXT_RECORDS = 20


class HealthResult(TypedDict):
    available: bool
    domain: str
    spf: str
    dkim: str
    dmarc: str


def _empty(domain: str, *, available: bool) -> HealthResult:
    status = "unknown"
    return {
        "available": available,
        "domain": domain,
        "spf": status,
        "dkim": status,
        "dmarc": status,
    }


def _txt_records(name: str) -> list[str]:
    """Return decoded TXT strings for ``name`` (bounded), or [] on any DNS miss."""
    import dns.resolver  # local import: optional at runtime, degrades gracefully

    resolver = dns.resolver.Resolver()
    resolver.lifetime = _DNS_TIMEOUT_SECONDS
    resolver.timeout = _DNS_TIMEOUT_SECONDS
    try:
        answer = resolver.resolve(name, "TXT")
    except Exception:
        # NXDOMAIN, timeout, no-answer, servfail — all mean "record not found".
        return []
    records: list[str] = []
    for rdata in answer:
        # Each TXT rdata is one or more byte strings; join then decode.
        try:
            value = b"".join(getattr(rdata, "strings", [])).decode("utf-8", "replace")
        except Exception:  # pragma: no cover — defensive
            continue
        records.append(value)
        if len(records) >= _MAX_TXT_RECORDS:
            break
    return records


def check_deliverability(from_email: str, dkim_selector: str = "") -> HealthResult:
    """Resolve SPF / DKIM / DMARC posture for the From domain.

    ``from_email`` is the persisted, EmailField-validated address; the domain is
    everything after the last ``@``. Returns ``available = False`` when there is
    no From domain or the DNS resolver is not installed.
    """
    domain = from_email.rsplit("@", 1)[-1].strip().lower() if "@" in from_email else ""
    if not domain:
        return _empty(domain, available=False)

    try:
        import dns.resolver  # noqa: F401 — availability probe
    except ImportError:  # pragma: no cover — dnspython is a hard dependency
        logger.info("check_deliverability: dnspython not installed; degrading")
        return _empty(domain, available=False)

    # SPF: a v=spf1 TXT record on the apex.
    spf_records = _txt_records(domain)
    spf_terms = [r for r in spf_records if r.lower().startswith("v=spf1")]
    if not spf_terms:
        spf = "fail"
    elif any("-all" in r for r in spf_terms):
        spf = "pass"
    else:
        # ~all / ?all — present but not enforcing.
        spf = "warn"

    # DMARC: a v=DMARC1 TXT record at _dmarc.<domain>.
    dmarc_records = [
        r for r in _txt_records(f"_dmarc.{domain}") if r.lower().startswith("v=dmarc1")
    ]
    if not dmarc_records:
        dmarc = "fail"
    elif any("p=reject" in r.lower() or "p=quarantine" in r.lower() for r in dmarc_records):
        dmarc = "pass"
    else:
        dmarc = "warn"  # p=none (monitoring only)

    # DKIM: only checkable when a selector is configured; look up
    # <selector>._domainkey.<domain> for a v=DKIM1 / k= record.
    selector = dkim_selector.strip()
    if not selector:
        dkim = "warn"  # no selector configured — can't verify
    else:
        dkim_records = _txt_records(f"{selector}._domainkey.{domain}")
        has_dkim = any("v=dkim1" in r.lower() or "k=" in r.lower() for r in dkim_records)
        dkim = "pass" if has_dkim else "fail"

    return {
        "available": True,
        "domain": domain,
        "spf": spf,
        "dkim": dkim,
        "dmarc": dmarc,
    }
