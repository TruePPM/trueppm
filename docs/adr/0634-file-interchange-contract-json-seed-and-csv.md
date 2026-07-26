# ADR-0634 — One file-interchange contract: the JSON seed is the fidelity format, CSV is the tabular format

- **Status:** Accepted
- **Date:** 2026-07-26
- **Issue:** #2397
- **Extends:** ADR-0109 (canonical JSON seed schema), ADR-0114 (seed v2 relative dates
  + event replay), ADR-0092 (import project from file), ADR-0219 (async project export
  bundle), ADR-0043 (risk register CSV), ADR-0086 / ADR-0204 (schema-version convention)
- **Normative spec:** `docs/specs/data-interchange.spec.md`
- **Defers to:** #1959 (identity-preserving round-trip, 0.5), #2399 (integrity manifest,
  0.5), #2400 (encrypted export artifacts, 0.5), #2401 (CSV exporter conformance, 0.5)

## Context

TruePPM has two families of file interchange and they are specified at wildly
different levels of rigor.

The **canonical JSON seed** has a committed JSON Schema (`seed_v1.json`,
`seed_v2.json`), a validator with JSON-path-anchored errors, a version convention, a
byte-identical round-trip guarantee enforced in CI, and four ADRs describing it.

**CSV** has none of that. What exists is three independent implementations that each
invented their own dialect:

| Surface | Where | Direction | Dialect decisions made locally |
|---|---|---|---|
| Task/Grid export | `packages/web/src/utils/exportCsv.ts` | export | 8 fixed columns, ISO dates, `Yes/No` booleans, CRLF, comma |
| Risk export | `packages/web/src/features/risk/riskExport.ts` | export | 13 columns, **humanized** dates (`Jun 9, 2026`), humanized enum labels |
| Risk import | `packages/api/.../projects/risk_import.py` | import | UTF-8-with-BOM, comma, 2 MB / 500 rows, header aliases, row-level error/warning split |

The asymmetry is not cosmetic. Three consequences are already in the tree:

1. **The task CSV export does not round-trip, and nothing anywhere says so.** It emits
   `WBS, Name, Start, Finish, Duration (days), Progress (%), Status, Critical` — where
   `Start`/`Finish` are *computed CPM results* and `Critical` is a *derived* flag. There
   is no importer that reads it. A user reasonably reads a "CSV" button as "my data,
   portable" and it is not: no ids, no predecessors, no assignees, no estimates.

2. **The two exporters disagree with each other**, and the importer pays for it. Risk
   export humanizes dates, so `risk_import.py` has to carry a three-format date-parsing
   fallback (`%Y-%m-%d`, `%b %d, %Y`, `%B %d, %Y`) to read its own exporter's output.
   That fallback is a symptom, not a design.

3. **#743 (CSV/Excel task import) is being implemented now**, against no normative column
   contract. Without one it will make delimiter, encoding, limit, error-model, and
   header-alias decisions a fourth time — and the resulting importer will not read the
   exporter sitting next to it in the same repo.

There is also an unexamined posture. Export artifacts — the sync seed, the `.tar.gz`
bundle — contain member and resource **email addresses** and, since #1957 closed the
field-privacy bypass, team-private points and velocity behind an Admin gate. Today those
artifacts are written to object storage **unchecksummed and unencrypted**. That is a
defensible position for 0.4 (authenticated-only download, 7-day TTL, nightly purge, no
presigned URL, operator-owned private bucket) but it has never been *stated*, so nobody
can tell a deliberate choice from an oversight.

## Decision

### 1. Two formats, two jobs, and the jobs are not interchangeable

> **The JSON seed is the fidelity format. CSV is the tabular format.**
> A CSV file is never a backup, never a migration artifact, and never the input to a
> restore. The JSON seed is the only format that carries a whole program.

This is the load-bearing sentence of this ADR, and every other rule follows from it.
CSV's limitations are *structural*, not gaps waiting to be filled: a CSV is a flat,
untyped, single-entity table with no way to express nesting, cross-entity references,
or a schema version. Attempting to make CSV a fidelity format means reinventing JSON
badly inside a spreadsheet.

Both formats nonetheless answer to **one contract**, so that a reader of either spec
section finds the same headings in the same order: scope · direction · identity model ·
fidelity tier · encoding & dialect · limits · error model · RBAC tier · limitations.

### 2. Three fidelity tiers, named, so "does it round-trip?" has an answer

Every interchange surface is labeled with exactly one tier. The tier is the honest
answer to "if I export this and import it back, what do I get?"

| Tier | Name | Guarantee | Re-importable? |
|---|---|---|---|
| **T0** | **View snapshot** | A rendering of what is on screen, including *computed* values. Column set is presentational and may change with the view. | **No.** Not an input to any importer. |
| **T1** | **Structural re-import** | Re-import reconstructs the structure faithfully, but **mints new identity** — new UUIDs, new `server_version`. Cross-refs resolve by file-local slug / `wbs_path`. | Yes, as a **new** object. Never an update-in-place. |
| **T2** | **Identity-preserving** | Re-import updates the *same* objects in place; UUIDs and sync bookkeeping survive. | Yes, as an update. **Not shipped** — #1959, 0.5. |

Assignments as of 0.4:

| Surface | Format | Direction | Tier |
|---|---|---|---|
| Program seed (`GET /programs/{id}/export/`) | JSON | export | **T1** |
| Project seed (`GET /projects/{id}/export/`) | JSON | export | **T1** |
| Program import (`POST /programs/import/`) | JSON | import | **T1** |
| Export bundle (`.tar.gz`, project & program) | JSON + sidecars | export | **T1** seed, **T0** sidecars |
| MS Project XML | MSPDI | both | **T1** |
| Risk register CSV | CSV | both | **T1** |
| Task/Grid CSV | CSV | export | **T0** |
| Task CSV/Excel import (#743, 0.4) | CSV/XLSX | import | **T1** |

The two rows worth staring at are the last two. **The 0.4 task CSV import is not the
inverse of the 0.4 task CSV export** — they are a T1 importer and a T0 exporter that
happen to share a file extension. The spec says so in both directions rather than
implying a symmetry that does not exist. Making them inverses is a real, worthwhile
follow-up (#2401), but it is a *change*, not a bug fix, and it is not 0.4.

### 3. One CSV dialect, fixed normatively, for every producer and consumer

Every TruePPM CSV — whichever surface writes or reads it — is:

- **RFC 4180**, comma-delimited. Not locale-negotiated, not semicolon, not tab.
- **UTF-8**. A leading BOM is *accepted* on read (Excel writes one) and **not written**
  on export.
- **CRLF** line endings on write; either accepted on read.
- **Row 1 is a header row.** Column *order* is not significant on read; the header names
  are. Matching is case-insensitive and whitespace-trimmed.
- **Dates are ISO 8601 `YYYY-MM-DD` on write.** Readers additionally accept the two
  legacy humanized forms already in the wild. This reverses the risk exporter's current
  humanization — a machine-readable format writes machine-readable dates, and the human
  reading it in Excel still sees a date because Excel parses ISO.
- **Enums are written as the stored value.** Readers accept the stored value *or* the
  human label.
- Blank rows and rows whose first cell starts with `#` are skipped.
- Unknown columns are ignored with a warning, never a hard failure.

The delimiter decision deserves its rationale, because it is the one users hit: in
locales where Excel's list separator is `;`, a comma-delimited file opens as one column
until the user runs Text-to-Columns. We take that cost deliberately. The alternative —
sniffing or negotiating the delimiter — makes the file's meaning depend on the machine
that opens it, which is exactly the property that disqualifies CSV as a fidelity format.
We document the Excel workaround instead of making the format ambiguous.

### 4. The error model is the same shape for both formats

- **File-level failure** → HTTP 400, whole operation rejected, nothing persisted. For
  JSON, the message is anchored to a JSON path; for CSV, to the file or the header row.
- **Row-level / node-level problems** split into **errors** (that row is skipped, the
  rest of the import proceeds) and **warnings** (the row is imported with a coerced or
  defaulted value). Both carry a 1-based line number where the header is line 1.
- **Partial success is a result, not a failure.** It is the common case for a
  spreadsheet import and the API and UI must both present it that way.
- The whole import is one `transaction.atomic()`; a file-level failure never leaves a
  partial object graph.

### 5. Integrity and confidentiality are named now, built later — and 0.4 ships neither

This ADR fixes the *design intent* so that the 0.4 posture is a stated choice, and so
the follow-ups do not have to relitigate it.

**Integrity — content hashing (#2399, 0.5).** Export artifacts today carry no checksum.
The decision of record is a **SHA-256 integrity manifest**: each member of a `.tar.gz`
bundle gets a digest in `manifest.json`, plus one digest over the canonicalized manifest
itself, and the download endpoint surfaces the artifact digest in a response header. Two
things this buys that are not "security theater": it makes the ADR-0109 byte-identical
round-trip guarantee *verifiable by the user* rather than only by CI, and it lets an
import detect a truncated or edited artifact before it starts writing. Deliberately **not**
a signature — signing needs a key-management story (whose key, distributed how,
rotated when) that a self-hosted single-tenant deployment does not have, and an unsigned
digest that only detects corruption is honest about what it is.

**Confidentiality — encryption at rest (#2400, 0.5).** Export artifacts contain email
addresses and, at the Admin tier, team-private velocity. Today they sit in the operator's
object storage in the clear, protected by the bucket ACL and the authenticated-download
path. The decision of record is **optional passphrase- or recipient-based encryption of
the artifact at generation time** (age/OpenPGP-shaped: the server never retains the
passphrase, and a lost passphrase means a lost artifact — which is the correct
trade-off for a backup you can regenerate). Encryption is **opt-in per export**, never a
silent default, because a silently-encrypted export that the user cannot open is worse
than a plaintext one they chose.

**0.4 ships unencrypted, unchecksummed artifacts.** This is in scope for the beta and is
correct for it: the existing controls (Admin-only generation, authenticated-only
download, 7-day TTL, nightly purge, no presigned URL, private bucket) are the ones that
actually gate access, and adding a key-management surface to a beta would add more risk
than it removes. What 0.4 *must* do — and this ADR requires — is **say so in the
documentation**, next to the operator note about bucket privacy.

### 6. CSV never carries a field the JSON seed refuses to carry

A recurring failure mode in interchange work is that the "quick tabular export" quietly
becomes the widest egress path in the product, because nobody reviewed it against the
privacy model. Rule: any field gated in the seed exporter (ADR-0104 team-private
signals) is gated identically in every CSV exporter, and a CSV export sits at the same
RBAC tier as the equivalent seed export. A CSV export is not a lower-privilege
operation because the file is smaller.

## Consequences

**Easier.** #743/#746 have a column contract to implement against instead of inventing
a fourth dialect. "Does this round-trip?" has a one-word answer (the tier) on every
surface. The doc that tells a user CSV is not a backup exists, so the first person to
try restoring from one finds out beforehand rather than afterward. The 0.4 security
posture on export artifacts is a written decision that a reviewer can agree or disagree
with.

**Harder.** The ISO-date and stored-enum rules in §3 mean the *risk* CSV exporter is now
non-conformant with the spec it is documented under, and the Grid task exporter is
non-conformant on several counts. Neither is changed here — this ADR is spec-only, and
changing an exporter's output shape is a user-visible change that needs its own issue
(#2401) and its own tests. Until that lands, the spec marks those two surfaces
**"conformance pending"** rather than pretending they comply.

**Risk.** Naming T2 (identity-preserving) as a tier could read as a promise that 0.4
does something it does not. The mitigation is that the tier table above and the
user-facing docs both state 0.4's tier explicitly per surface, and the words
"re-importing creates a new program" appear in the docs rather than only in an ADR.

## Alternatives rejected

| Option | Why not |
|---|---|
| **Leave CSV unspecified; it is "just a spreadsheet"** | This is the status quo that produced three incompatible dialects and an importer that has to reverse-engineer its own exporter. The cost is paid by every subsequent implementer. |
| **Make CSV a fidelity format** (multi-file CSV bundle, id columns, a version row) | Reinvents the JSON seed inside a format with no nesting, no types, and no schema. The seed already exists and already round-trips. |
| **Negotiate the CSV delimiter** (sniff, or a `sep=` preamble) | Makes a file's meaning depend on the reader's locale, which is the property that disqualifies CSV from being authoritative. The Excel `;` friction is real but is a documented one-time Text-to-Columns step. |
| **Ship encryption in 0.4** | Adds key management — the hardest part — to a beta. The access controls that matter (Admin gate, authenticated download, TTL, private bucket) are already in place; encryption without a key story is a lock with the key taped to it. |
| **Sign artifacts rather than hash them** | No key-distribution story exists for a self-hosted single-tenant deployment. A digest that detects corruption, honestly labeled as such, is worth more than a signature nobody can verify. |
| **One unified spec with no per-format split** | The formats have genuinely different capabilities; a merged spec hides that. The symmetric-headings structure gives the comparability without pretending at equivalence. |

## Implementation notes

- **P3M layer:** Programs and Projects
- **Affected packages:** docs only in this change; `api` and `web` in the follow-ups
- **Migration required:** no
- **API changes:** none in this ADR
- **OSS or Enterprise:** **OSS.** Per-project and per-program export/import is the
  portability every self-hoster is entitled to. The Enterprise line sits at
  *org-mandated policy over* interchange — DLP rules, mandated retention/encryption
  policy, org-wide egress audit — not at the ability to get one's own data out.
- **Durable execution:** unchanged. Synchronous seed export/import stays in-request
  (ADR-0109 §Durable Execution); the async bundle path stays on the export-job pattern
  (ADR-0219). The follow-ups (#2399, #2400) both act inside the existing bundle-build
  task and add no new dispatch.
