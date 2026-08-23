# Risk-register CSV encoding fixtures

On-disk fixtures for the cases a hand-built `bytes` literal is the wrong tool for
(#2937, the #2892 class at a fourth site). The bug these cover lives at the
**decode boundary**: a unit test that starts from a Python `str` has already
decoded the file and therefore cannot see it. These are read as raw bytes and fed
to `parse_risk_csv` exactly as an uploaded file is.

All four carry the same two risks (`Data loss`, `Café outage`) so a decode that
goes wrong is visible as a changed *value*, not just a changed error.

| File | What it is | Expected outcome |
|---|---|---|
| `risks_utf8.csv` | Plain UTF-8, CRLF | Imports; the accented title round-trips |
| `risks_cp1252.csv` | Windows-1252 export | Imports; `Café outage` round-trips. Before #2937 this was **refused** — the strict `utf-8-sig` decode raised on byte `0xE9` |
| `risks_utf16_bom.csv` | Little-endian UTF-16 behind a BOM — what Excel's UTF-16 CSV export writes | Imports. Before #2937 this was refused (`\xff\xfe` is invalid UTF-8) |
| `risks_utf16_no_bom.csv` | The same UTF-16 stream with the BOM stripped | Refused with a `RiskImportError` naming the re-save fix — and must **never** import as mojibake, which is exactly what it did before #2937 |

Regenerate with the snippet in `test_risk_import_encoding.py`'s module docstring
if a file is ever lost; do **not** re-save them through an editor, which will
helpfully "fix" the encoding and quietly void the test.
