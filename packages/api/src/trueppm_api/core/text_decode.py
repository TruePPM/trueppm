"""The one decoder for uploaded delimited-text files (#2892, #2937).

Decoding an upload is not "call ``.decode()``". The hazard is that the useful
fallback codecs — cp1252 and latin-1 — map almost every byte, so a *wrong* guess
**succeeds** and yields mojibake instead of an error. UTF-16 read as cp1252
becomes NUL-interleaved text; because header matching strips non-alphanumerics
before comparing, that mojibake still matched its aliases at
``confidence="exact"`` and the import wizard rendered a fully-green mapping over
a file it had comprehensively misread (#2892).

Strict UTF-8 is not the fix either, and looks like one. ``raw.decode("utf-8-sig")``
reads as fail-closed and is, for a *BOM'd* UTF-16 file — ``\\xff\\xfe`` is invalid
UTF-8, so it raises. But **NUL is a valid UTF-8 code point**, so a BOM-*less*
UTF-16 stream decodes without raising, straight into mojibake. That was
``risk_import._decode`` for its whole life (#2937): the same class as #2892, at a
fourth site, in a second app, three months after the first fix.

Which is the reason this module exists rather than a second copy of the guard.
#2892 fixed one importer and left the logic private to it; #2937 is what that
costs. ``tests/test_uploaded_text_decode_sites.py`` now enforces the boundary:
no module in ``apps/`` that imports ``csv`` may call ``.decode(`` itself.

The strategy, in order:

1. **A byte-order mark wins outright.** It is the one piece of encoding evidence
   that is not a guess.
2. **Otherwise walk the ladder**, strict codecs first.
3. **Then check the output**, because steps 1–2 can succeed and still be wrong.
   A refusal names the fix; mojibake names nothing.

Callers translate :class:`TextDecodeError` into their own domain exception so
their existing messages and 400 responses are unchanged.
"""

from __future__ import annotations

import codecs


class TextDecodeError(Exception):
    """An upload could not be read as delimited text, or decoded wrong."""


#: Advice appended to every decode refusal. Named once so both importers, the
#: wizard, the tests, and the docs quote the same sentence.
ENCODING_ADVICE = "Re-save the file as UTF-8 CSV (in Excel: File → Save As → CSV UTF-8)."

#: Text encodings tried in order when the upload carries no byte-order mark.
#: utf-8-sig first so a BOM written by Excel is consumed rather than becoming part
#: of the first header ("﻿Name"). cp1252 and latin-1 are lossy fallbacks: they
#: map almost every byte and therefore never raise, so a wrong guess reaching them
#: produces mojibake rather than an error. ``_reject_undecodable`` is what stops
#: that (#2892).
_ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")

#: Byte-order marks mapped to the codec that consumes them, longest mark first.
#:
#: Order is load-bearing, not cosmetic: ``BOM_UTF32_LE`` is ``BOM_UTF16_LE``
#: followed by two NUL bytes, so testing the 2-byte UTF-16 mark first would
#: classify every UTF-32 file as UTF-16. The named codecs ("utf-16", "utf-32")
#: rather than the endian-specific ones are deliberate — they consume the mark,
#: which the ``-le``/``-be`` variants leave in the text as U+FEFF.
_BOM_ENCODINGS: tuple[tuple[bytes, str], ...] = (
    (codecs.BOM_UTF32_LE, "utf-32"),
    (codecs.BOM_UTF32_BE, "utf-32"),
    (codecs.BOM_UTF8, "utf-8-sig"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
)

#: How much of a decoded upload the undecodable-text guard inspects. The check is
#: a ratio over a prefix rather than the whole string so its cost is constant for
#: a 100 MB workbook; a decode wrong enough to matter is wrong from byte one.
_DECODE_SAMPLE_CHARS = 65_536

#: Share of control characters (excluding tab / CR / LF) above which a decode is
#: treated as failed rather than merely odd. A real spreadsheet export carries
#: essentially none; anything at this level means the bytes were run through the
#: wrong codec.
_MAX_NON_PRINTABLE_RATIO = 0.2


def _encoding_from_bom(content: bytes) -> str | None:
    """Name the codec a leading byte-order mark declares, or ``None``.

    A BOM is the one piece of encoding evidence that is not a guess, so it wins
    outright over the ``_ENCODINGS`` ladder — which cannot be trusted to reach the
    right answer, because its lossy tail decodes anything.
    """
    for bom, encoding in _BOM_ENCODINGS:
        if content.startswith(bom):
            return encoding
    return None


def _reject_undecodable(text: str) -> None:
    """Refuse text that decoded without raising but plainly decoded wrong.

    The hazard the ``_ENCODINGS`` ladder creates is not a missing codec — it is
    that cp1252 and latin-1 map nearly every byte, so a wrong guess *succeeds*.

    So the guard is on the *output*: a spreadsheet export contains no NUL and
    essentially no other control characters, and either signal means the bytes
    went through the wrong codec. Raising here is strictly better than importing
    the mojibake, because a refusal names the fix and mojibake names nothing.

    Raises:
        TextDecodeError: The decoded text cannot be spreadsheet text.
    """
    sample = text[:_DECODE_SAMPLE_CHARS]
    if "\x00" in sample:
        raise TextDecodeError(
            "The file could not be read as text — the decoded content contains NUL "
            "bytes, which means it is not in the encoding it appears to be (a "
            f"UTF-16 file saved without a byte-order mark does this). {ENCODING_ADVICE}"
        )
    if not sample:
        return
    # Tab, CR and LF are structural in delimited text; every other control
    # character is evidence of a bad decode.
    non_printable = sum(1 for ch in sample if ch < " " and ch not in "\t\r\n")
    if non_printable / len(sample) > _MAX_NON_PRINTABLE_RATIO:
        raise TextDecodeError(
            "The file could not be read as text — most of it is not readable "
            "characters, so it is either binary or in an unexpected encoding. "
            f"{ENCODING_ADVICE}"
        )


def decode_uploaded_text(content: bytes) -> str:
    """Decode an uploaded delimited-text file, refusing a decode that went wrong.

    Args:
        content: The raw uploaded bytes, exactly as received.

    Returns:
        The decoded text.

    Raises:
        TextDecodeError: No codec produced usable spreadsheet text. Callers
            translate this into their own domain exception; the message is
            written to be shown to the uploader as-is and always names the fix.
    """
    bom_encoding = _encoding_from_bom(content)
    if bom_encoding is not None:
        try:
            text = content.decode(bom_encoding)
        except UnicodeDecodeError as exc:
            raise TextDecodeError(
                f"The file declares a {bom_encoding} byte-order mark but does not "
                f"decode as {bom_encoding}. {ENCODING_ADVICE}"
            ) from exc
        _reject_undecodable(text)
        return text

    for encoding in _ENCODINGS:
        try:
            text = content.decode(encoding)
        except UnicodeDecodeError:
            continue
        # Deliberately not "try the next codec": the remaining codecs are the
        # lossy ones, and they produce the same mojibake from the same bytes.
        # A failed decode has to become an error, not a quieter guess.
        _reject_undecodable(text)
        return text
    # latin-1 maps every byte, so this is unreachable in practice; keep the
    # explicit raise so a future edit to _ENCODINGS cannot silently return None.
    raise TextDecodeError(f"Could not decode the file as text. {ENCODING_ADVICE}")
