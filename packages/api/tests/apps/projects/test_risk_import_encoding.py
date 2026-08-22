"""Risk-register CSV decode boundary (#2937 — the #2892 class at a fourth site).

``risk_import._decode`` was a strict ``raw.decode("utf-8-sig")``. That reads as
fail-closed and is, for a *BOM'd* UTF-16 file: ``\\xff\\xfe`` is invalid UTF-8, so
it raised. But **NUL is a valid UTF-8 code point**, so a BOM-*less* UTF-16 stream
decoded without raising and imported risks titled
``D\\x00a\\x00t\\x00a\\x00 \\x00l\\x00o\\x00s\\x00s\\x00``.

Every case here starts from **bytes on disk**, never from a Python ``str``. That
is not stylistic: a test that builds its input as a ``str`` has already decoded
the file and is structurally incapable of seeing this bug — which is why the
importer shipped with tests and the defect anyway.

Regenerate the fixtures with::

    rows = ("Title,Status,Category,Probability,Impact\\r\\n"
            "Data loss,open,technical,3,5\\r\\n"
            "Café outage,open,external,2,4\\r\\n")
    d = pathlib.Path("tests/apps/projects/files")
    (d / "risks_utf16_bom.csv").write_bytes(rows.encode("utf-16"))
    (d / "risks_utf16_no_bom.csv").write_bytes(rows.encode("utf-16-le"))
    (d / "risks_cp1252.csv").write_bytes(rows.encode("cp1252"))
    (d / "risks_utf8.csv").write_bytes(rows.encode("utf-8"))
"""

from __future__ import annotations

from pathlib import Path

import pytest

from trueppm_api.apps.projects.risk_import import RiskImportError, parse_risk_csv

_FILES = Path(__file__).parent / "files"


def _raw(name: str) -> bytes:
    return (_FILES / name).read_bytes()


def _titles(raw: bytes) -> list[str]:
    return [draft.title for draft in parse_risk_csv(raw, {}).drafts]


class TestRiskCsvDecodes:
    """Encodings a real export produces must import, with values intact."""

    @pytest.mark.parametrize(
        "fixture",
        [
            pytest.param("risks_utf8.csv", id="utf-8"),
            # Refused before #2937: the strict utf-8-sig decode raised on 0xE9.
            pytest.param("risks_cp1252.csv", id="cp1252"),
            # Refused before #2937: \xff\xfe is not valid UTF-8. This is what
            # Excel's UTF-16 CSV export writes, so refusing it was its own bug.
            pytest.param("risks_utf16_bom.csv", id="utf-16-with-bom"),
        ],
    )
    def test_imports_with_values_intact(self, fixture: str) -> None:
        assert _titles(_raw(fixture)) == ["Data loss", "Café outage"]


class TestRiskCsvRefusesBadDecode:
    """The defect: decoded without raising, straight into mojibake."""

    def test_bom_less_utf16_is_refused(self) -> None:
        with pytest.raises(RiskImportError) as exc:
            parse_risk_csv(_raw("risks_utf16_no_bom.csv"), {})
        assert "Re-save the file as UTF-8 CSV" in str(exc.value)

    def test_bom_less_utf16_never_imports_as_mojibake(self) -> None:
        """The assertion that would have failed before the fix.

        Deliberately not written as ``pytest.raises`` around the call: the failure
        mode here was a *successful* import of garbage, so the property worth
        pinning is "no mojibake row exists", and the report on regression should
        show the titles that got through rather than just "DID NOT RAISE".
        """
        try:
            plan = parse_risk_csv(_raw("risks_utf16_no_bom.csv"), {})
        except RiskImportError:
            return  # Refused — the correct outcome.
        pytest.fail(
            "imported NUL-interleaved mojibake instead of refusing: "
            f"{[draft.title for draft in plan.drafts]!r}"
        )

    @pytest.mark.parametrize(
        "raw",
        [
            pytest.param("Title,Status\nData loss,open\n".encode("utf-16-le"), id="utf-16-le"),
            pytest.param("Title,Status\nData loss,open\n".encode("utf-16-be"), id="utf-16-be"),
            pytest.param("Title,Status\nData loss,open\n".encode("utf-32-le"), id="utf-32-le"),
        ],
    )
    def test_every_bom_less_wide_encoding_is_refused(self, raw: bytes) -> None:
        """Both UTF-16 endiannesses and UTF-32 — the issue verified all three."""
        with pytest.raises(RiskImportError):
            parse_risk_csv(raw, {})


def test_an_empty_upload_still_reports_empty_not_a_decode_error() -> None:
    """Delegating the decode must not reclassify the existing empty-file error."""
    with pytest.raises(RiskImportError) as exc:
        parse_risk_csv(b"", {})
    assert "empty" in str(exc.value).lower()
