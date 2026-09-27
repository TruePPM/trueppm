"""Pure key rules for project and program keys (ADR-1237).

A key is the human address of a project (``PLAT``) or program
(``atlas-platform-launch``), stored denormalized as ``code`` and, with its whole
history, as ``ObjectKey`` rows. This module holds only the rules that need no
database: format, reserved words, normalization, the derivation of a base key
from a name, and the suffixing that makes a base key free. It is deliberately
ORM-free so the migration repair (``projects.backfill``) can reuse exactly the
rules the live service applies — two copies of a derivation rule drift, and a
backfill that derives ``PLAT`` differently from the create path would leave the
upgrade and the next create disagreeing about what a name's key is.

The database-aware halves (``derive_key``, ``assign_key``) live in
``apps.projects.services``.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable

KIND_PROJECT = "project"
KIND_PROGRAM = "program"
KINDS = (KIND_PROJECT, KIND_PROGRAM)

#: New project keys: a letter, then 1-9 letters or digits. No hyphen, so a
#: reference is ``-``-separated like Jira and the shipped ``PLAT-R-7``.
PROJECT_KEY_RE = re.compile(r"[A-Z][A-Z0-9]{1,9}")
PROJECT_KEY_MAX = 10
#: Pre-ADR-1237 project codes (hyphens allowed, <=12). Grandfathered: a stored
#: value in this shape is never rewritten and still resolves, but no *new* value
#: may take it.
LEGACY_PROJECT_CODE_RE = re.compile(r"[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?")
LEGACY_PROJECT_CODE_MAX = 12
#: Program keys stay slugs, because seed replace keys on ``program.slug``.
PROGRAM_KEY_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?")
PROGRAM_KEY_MAX = 40

#: Route segments a key must never shadow (``/projects/new``, ``/projects/trash``).
RESERVED_KEYS = frozenset({"new", "settings", "trash"})
_UUID_SHAPED = re.compile(
    r"[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}", re.IGNORECASE
)

#: The DoS bound on renames (ADR-1237 threat model, D): a rename loop would
#: otherwise reserve keys forever.
MAX_RETIRED_KEYS = 10

#: Cap on how many candidates :func:`next_free_key` will probe (security-review
#: Low, perf-check Low). Without a bound, namespace squatting — deliberately
#: registering every key in a popular name's suffix run (``PLAT``, ``PLAT2``,
#: ``PLAT3``, …) — turns another user's create or rename into an unbounded
#: loop of 1-2 queries per candidate. 1000 is far past any real collision run
#: (the suffix cap already trims the base to fit ``PROJECT_KEY_MAX``/
#: ``PROGRAM_KEY_MAX``, so exhausting it needs 1000 deliberately-squatted keys
#: for one base) and still resolves in well under the ``resolve`` throttle's
#: per-request budget.
MAX_SUFFIX_ATTEMPTS = 1000

# The en dash matches the UX copy (ADR-1237 UX spec §1) the web renders verbatim.
PROJECT_FORMAT_MESSAGE = "Letters and digits only, starting with a letter, 2–10 characters."  # noqa: RUF001
PROGRAM_FORMAT_MESSAGE = "Lowercase letters, digits and hyphens, up to 40 characters."
RESERVED_MESSAGE = "That word is reserved."
IN_USE_MESSAGE = "This key is already in use."
CAP_MESSAGE = (
    f"This key has been changed {MAX_RETIRED_KEYS} times, the most allowed. "
    "Contact your workspace admin."
)

_PROJECT_FALLBACK = "PROJ"
_PROGRAM_FALLBACK = "program"

SUFFIX_EXHAUSTED_MESSAGE = "Couldn't find a free key from this name — please choose one."


class KeyAssignmentError(ValueError):
    """A key write refused for a caller-correctable reason; always a ``400`` on ``code``.

    Defined here rather than in ``services.py`` (its main call site and the
    module every existing ``except KeyAssignmentError`` imports it from)
    because :func:`next_free_key` below must be able to raise it, and this
    module is deliberately import-light (see the module docstring) — nothing
    here may depend on ``services.py``. ``services.py`` re-exports this name,
    so every existing ``from trueppm_api.apps.projects.services import
    KeyAssignmentError`` keeps working unchanged.

    The message never names the object holding a taken key — the existence
    oracle ADR-1237 §6 accepts leaks *that* a key is taken, never *by what*.
    """


def is_uuid_shaped(value: str) -> bool:
    """True when ``value`` would read as a UUID (hyphenated or bare hex)."""
    return bool(_UUID_SHAPED.fullmatch(value))


def normalize_key(key: str, kind: str) -> str:
    """Canonical case for ``kind``: project keys upper, program keys lower.

    Comparison is case-insensitive either way; normalizing on write means the
    stored form is what a user would have typed into the UI, which uppercases
    (project) or lowercases (program) as they type.
    """
    stripped = (key or "").strip()
    return stripped.upper() if kind == KIND_PROJECT else stripped.lower()


def key_format_error(key: str, kind: str) -> str | None:
    """Why ``key`` cannot be a *new* key of ``kind``, or ``None`` when it can.

    Expects an already-normalized key. Reserved words and UUID-shaped values are
    checked for both kinds: a key must never shadow a route segment or be
    mistaken for the UUID it stands in for.
    """
    if kind == KIND_PROJECT:
        if not PROJECT_KEY_RE.fullmatch(key):
            return PROJECT_FORMAT_MESSAGE
    elif len(key) > PROGRAM_KEY_MAX or not PROGRAM_KEY_RE.fullmatch(key):
        return PROGRAM_FORMAT_MESSAGE
    if key.lower() in RESERVED_KEYS or is_uuid_shaped(key):
        return RESERVED_MESSAGE
    return None


def is_reserved(key: str) -> bool:
    """True for a reserved word or a UUID-shaped value (either kind)."""
    return key.lower() in RESERVED_KEYS or is_uuid_shaped(key)


def _ascii(value: str) -> str:
    return unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode("ascii")


def base_key_for(name: str, kind: str) -> str:
    """The un-suffixed key a ``name`` suggests. Always a valid new key of ``kind``.

    Project: the initials of a multi-word name (``Platform Migration`` → ``PM``),
    or the first four characters of a single word (``Platform`` → ``PLAT``). A
    result that would start with a digit gets a ``P`` prefix. Program: the name
    slugified to ``[a-z0-9-]``, capped at 40.

    Reserved and UUID-shaped results are *not* rejected here — they are valid
    shapes that :func:`next_free_key` steps past with a suffix, the same way it
    steps past a taken key.
    """
    if kind == KIND_PROJECT:
        words = re.findall(r"[A-Za-z0-9]+", _ascii(name))
        if len(words) >= 2:
            base = "".join(word[0] for word in words)
        elif words:
            base = words[0][:4]
        else:
            base = ""
        base = base.upper()
        if base and base[0].isdigit():
            base = f"P{base}"
        base = base[:PROJECT_KEY_MAX]
        if len(base) < 2:
            # One-letter initials ("X") or nothing usable at all.
            base = (base + words[0][1:4].upper()) if words and len(words[0]) > 1 else ""
            base = base[:PROJECT_KEY_MAX]
        if not PROJECT_KEY_RE.fullmatch(base):
            base = _PROJECT_FALLBACK
        return base
    slug = re.sub(r"[^a-z0-9]+", "-", _ascii(name).lower()).strip("-")
    slug = slug[:PROGRAM_KEY_MAX].rstrip("-")
    return slug or _PROGRAM_FALLBACK


def _suffixed(base: str, n: int, kind: str) -> str:
    if kind == KIND_PROJECT:
        tail = str(n)
        return base[: PROJECT_KEY_MAX - len(tail)] + tail
    tail = f"-{n}"
    return base[: PROGRAM_KEY_MAX - len(tail)].rstrip("-") + tail


def next_free_key(base: str, kind: str, is_taken: Callable[[str], bool]) -> str:
    """``base`` if free, else the first free ``base2``/``base3``… (``base-2`` for programs).

    ``is_taken`` is asked about each candidate; reserved and UUID-shaped
    candidates are skipped without asking. The suffix trims the base rather than
    exceeding the length cap, so ``ABCDEFGHIJ`` steps to ``ABCDEFGHI2``.

    Raises:
        KeyAssignmentError: after :data:`MAX_SUFFIX_ATTEMPTS` candidates are all
            reserved or taken (security-review Low, perf-check Low). Without a
            bound, namespace squatting — pre-registering every suffix of a
            popular base — turns another caller's create or rename into an
            unbounded loop of 1-2 queries per candidate. Every caller of this
            function already sits behind (or is wrapped to sit behind) a
            ``KeyAssignmentError`` handler that turns it into a ``400`` on
            ``code``, so this is a caller-correctable refusal, not a crash.
    """
    candidate = base
    n = 1
    attempts = 1
    while is_reserved(candidate) or is_taken(candidate):
        if attempts >= MAX_SUFFIX_ATTEMPTS:
            raise KeyAssignmentError(SUFFIX_EXHAUSTED_MESSAGE)
        n += 1
        candidate = _suffixed(base, n, kind)
        attempts += 1
    return candidate
