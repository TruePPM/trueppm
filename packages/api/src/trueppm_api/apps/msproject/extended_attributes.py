"""MS Project ExtendedAttribute FieldID constants and PERT mapping.

These FieldIDs are the canonical MS Project Custom Field identifiers for the
idiomatic three-point / PERT estimate convention. They are sourced from MPXJ's
``TaskField`` enum (via the mpp-sample-generator's ``field_id_reference.md``)
and cross-checked against Microsoft's one documented anchor:
``pjCustomTaskText1 = 188743731``
(https://learn.microsoft.com/en-us/previous-versions/office/developer/office-2007/bb968474(v=office.12)).

The Duration family is **non-contiguous** within the Custom Field enumeration:
``Duration1``–``Duration3`` sit at 188743783–785 (contiguous), but ``Duration4``
(the PERT-Expected formula slot) lives 170 IDs higher at 188743955, in a
separate sub-range. Inferring one Duration FieldID by offset arithmetic from
another is wrong. Use these named constants — never a range.

ADR-0093 covers the import/export mapping decisions (alias-vs-FieldID
precedence, all-or-none rule, summary/milestone skipping, round-trip
tolerance).
"""

from __future__ import annotations

# Locked FieldIDs (sourced, not guessed). Strings because MSPDI carries them
# as text and we compare against text from the parsed XML.
DURATION1_FIELD_ID = "188743783"  # Optimistic
DURATION2_FIELD_ID = "188743784"  # Most Likely
DURATION3_FIELD_ID = "188743785"  # Pessimistic
DURATION4_FIELD_ID = "188743955"  # PERT Expected (formula slot, not imported)

# Semantic role -> FieldID. Duration4 is informational only: the formula slot
# is derived from the other three at file-read time by MS Project, so the
# importer never reads its value. The exporter still emits the definition so
# Project knows the alias and formula.
PERT_FIELD_IDS: dict[str, str] = {
    "optimistic": DURATION1_FIELD_ID,
    "most_likely": DURATION2_FIELD_ID,
    "pessimistic": DURATION3_FIELD_ID,
    "expected": DURATION4_FIELD_ID,
}

# FieldID -> the role it should play (used during import to recognize standard
# definitions).
PERT_ROLE_BY_FIELD_ID: dict[str, str] = {v: k for k, v in PERT_FIELD_IDS.items()}

# Canonical alias labels emitted on export.
PERT_ALIAS_LABELS: dict[str, str] = {
    DURATION1_FIELD_ID: "Optimistic",
    DURATION2_FIELD_ID: "Most Likely",
    DURATION3_FIELD_ID: "Pessimistic",
    DURATION4_FIELD_ID: "PERT Expected",
}

# Canonical FieldName labels (Duration1..4). MS Project uses these as the
# native field identifiers; the Alias is the user-visible label.
PERT_FIELD_NAMES: dict[str, str] = {
    DURATION1_FIELD_ID: "Duration1",
    DURATION2_FIELD_ID: "Duration2",
    DURATION3_FIELD_ID: "Duration3",
    DURATION4_FIELD_ID: "Duration4",
}

# Duration4 carries the PERT expected formula so MS Project re-derives the
# value on file open. Not a TruePPM field.
PERT_EXPECTED_FORMULA = "([Duration1] + 4*[Duration2] + [Duration3]) / 6"

# Substring tokens for alias confirmation (case-insensitive, first-match).
# These let us spot when a file has repurposed Duration1/2/3 with an alias
# that explicitly contradicts the PERT role (e.g. Duration1 aliased
# "Risk Score") and refuse the import for that field rather than silently
# treat unrelated values as estimates. Empty / missing aliases are treated
# as "no contradiction" — we trust the FieldID.
PERT_ALIAS_TOKENS: dict[str, tuple[str, ...]] = {
    DURATION1_FIELD_ID: ("optimistic",),
    DURATION2_FIELD_ID: ("most likely", "most-likely"),
    DURATION3_FIELD_ID: ("pessimistic",),
    DURATION4_FIELD_ID: ("pert", "expected"),
}
