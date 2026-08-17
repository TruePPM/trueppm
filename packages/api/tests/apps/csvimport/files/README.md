# CSV encoding / locale fixtures

On-disk fixtures for the cases a hand-built `bytes` literal in `fixtures.py` is
the wrong tool for (#2892). The bug these cover lives at the **decode boundary**:
a unit test that starts from a Python `str` has already decoded the file and
therefore cannot see it. These are read as raw bytes and fed to
`parse_spreadsheet` / the upload endpoints exactly as an uploaded file is.

| File | What it is | Expected outcome |
|---|---|---|
| `utf16_bom.csv` | Little-endian UTF-16 behind a BOM, CRLF endings — byte-for-byte what Excel's "Unicode Text (\*.txt)" / UTF-16 CSV export writes | Imports correctly: headers `Name`, `Duration`, `% Complete` |
| `utf16_no_bom.csv` | The same UTF-16 stream with the BOM stripped | Refused with a `CsvImportError` naming the re-save fix — not importable, and must never import as mojibake |
| `european_decimals.csv` | German/French Excel export: `;` column separator, comma decimal marks, one `1.500` period-grouped value | Durations 3.5 / 10.25 / 1.5 days, `0,5` read as 50 % complete |

Regenerate with the snippet in `test_encoding_and_locale.py`'s module docstring if
a file is ever lost; do **not** re-save them through an editor, which will helpfully
"fix" the encoding and quietly void the test.
