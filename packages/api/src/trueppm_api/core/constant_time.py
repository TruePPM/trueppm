"""The one constant-time comparison primitive for caller-controlled input (#2881, #2929).

``hmac.compare_digest`` (which ``secrets.compare_digest`` *is*) raises
``TypeError`` when either ``str`` argument contains a non-ASCII character. DRF
does not convert ``TypeError``, so any site that hands it a request-derived
string turns one byte of Latin-1 into an unhandled 500 — on precisely the
endpoints that are reachable anonymously, because those are the ones that
compare a secret against something a caller sent.

That defect shipped twice: once in the Git-webhook receiver (#2881), where the
500 was also an oracle — it is only reachable *after* the "is automation
configured?" check, so its mere shape told an anonymous caller that a project
has automation enabled with a secret set, exactly the fact the receiver's
uniform 404 exists to hide — and again in the SSO OIDC callback (#2929), where
the same line had the same flaw and the same-named test exercised it with an
ASCII value.

Two copies of the guard is how a third site appears silently, so this module is
the single home. ``tests/test_constant_time_compare_sites.py`` enforces that:
no other module in ``trueppm_api`` may call ``compare_digest`` directly.

Comparing **bytes** removes the raising path entirely rather than special-casing
the input. WSGI/ASGI hand header values over as ``Latin-1``-decoded text
(RFC 9110 §5.5), so ``latin-1`` round-trips the bytes a client actually sent;
the ``utf-8`` fallback covers input that carries a real code point above U+00FF
(a query parameter, a cookie, or a synthetic caller such as a test). Every
``expected`` value at our call sites is ASCII — a hex HMAC digest, a
``secrets.token_urlsafe`` secret, or a server-minted OAuth ``state`` — so no
encoding choice can make a mismatched value compare equal.
"""

from __future__ import annotations

import hmac


def constant_time_equal(provided: str, expected: str) -> bool:
    """Constant-time compare caller-controlled ``provided`` against ``expected``.

    Never raises on non-ASCII input. Both arguments may be attacker-controlled:
    the SSO callback compares a query parameter against a cookie, and both sides
    of that come from the request.
    """
    return hmac.compare_digest(_to_bytes(provided), _to_bytes(expected))


def _to_bytes(value: str) -> bytes:
    try:
        return value.encode("latin-1")
    except UnicodeEncodeError:
        return value.encode("utf-8")
